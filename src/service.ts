// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { Session, KernelSpec } from '@jupyterlab/services';

import { each } from '@lumino/algorithm';

import { IDisposable } from '@lumino/disposable';

import { ISignal, Signal } from '@lumino/signaling';

import { murmur2 } from 'murmurhash-js';

import { DebugProtocol } from 'vscode-debugprotocol';

import { CallstackModel } from './callstack/model';

import { DebuggerModel } from './model';

import { IDebugger } from './tokens';

import { IDebuggerEditorFinder } from './editor-finder';

import { VariablesModel } from './variables/model';

/**
 * A concrete implementation of IDebugger.
 */
export class DebuggerService implements IDebugger, IDisposable {
  /**
   * Instantiate a new DebuggerService.
   *
   * @param options The instantiation options for a DebuggerService.
   */
  constructor(options: DebuggerService.IOptions) {
    // Avoids setting session with invalid client
    // session should be set only when a notebook or
    // a console get the focus.
    // TODO: also checks that the notebook or console
    // runs a kernel with debugging ability
    this._session = null;
    this._specsManager = options.specsManager;
    this._model = new DebuggerModel();
  }

  /**
   * Whether the debug service is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Whether the current debugger is started.
   */
  get isStarted(): boolean {
    return this._session?.isStarted ?? false;
  }

  /**
   * Returns the current debug session.
   */
  get session(): IDebugger.ISession {
    return this._session;
  }

  /**
   * Sets the current debug session to the given parameter.
   *
   * @param session - the new debugger session.
   */
  set session(session: IDebugger.ISession) {
    if (this._session === session) {
      return;
    }
    if (this._session) {
      this._session.dispose();
    }
    this._session = session;

    this._session?.eventMessage.connect((_, event) => {
      if (event.event === 'stopped') {
        this._model.stoppedThreads.add(event.body.threadId);
        void this._getAllFrames();
      } else if (event.event === 'continued') {
        this._model.stoppedThreads.delete(event.body.threadId);
        this._clearModel();
        this._clearSignals();
      }
      this._eventMessage.emit(event);
    });
    this._sessionChanged.emit(session);
  }

  /**
   * Returns the debugger model.
   */
  get model(): IDebugger.IModel {
    return this._model;
  }

  /**
   * Sets the debugger model to the given parameter.
   *
   * @param model - The new debugger model.
   */
  set model(model: IDebugger.IModel) {
    this._model = model as DebuggerModel;
    this._modelChanged.emit(model);
  }

  /**
   * Signal emitted upon session changed.
   */
  get sessionChanged(): ISignal<IDebugger, IDebugger.ISession> {
    return this._sessionChanged;
  }

  /**
   * Signal emitted upon model changed.
   */
  get modelChanged(): ISignal<IDebugger, IDebugger.IModel> {
    return this._modelChanged;
  }

  /**
   * Signal emitted for debug event messages.
   */
  get eventMessage(): ISignal<IDebugger, IDebugger.ISession.Event> {
    return this._eventMessage;
  }

  /**
   * Request whether debugging is available for the session connection.
   *
   * @param connection The session connection.
   */
  async isAvailable(connection: Session.ISessionConnection): Promise<boolean> {
    await this._specsManager.ready;
    const kernel = connection?.kernel;
    if (!kernel) {
      return false;
    }
    const name = kernel.name;
    return !!(
      this._specsManager.specs.kernelspecs[name].metadata?.['debugger'] ?? false
    );
  }

  /**
   * Dispose the debug service.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._isDisposed = true;
    Signal.clearData(this);
  }

  /**
   * Computes an id based on the given code.
   *
   * @param code The source code.
   */
  getCodeId(code: string): string {
    return this._tmpFilePrefix + this._hashMethod(code) + this._tmpFileSuffix;
  }

  /**
   * Whether there exists a thread in stopped state.
   */
  hasStoppedThreads(): boolean {
    return this._model?.stoppedThreads.size > 0 ?? false;
  }

  /**
   * Starts a debugger.
   * Precondition: !isStarted
   */
  async start(): Promise<void> {
    await this.session.start();
  }

  /**
   * Stops the debugger.
   * Precondition: isStarted
   */
  async stop(): Promise<void> {
    await this.session.stop();
    if (this._model) {
      this._model.clear();
    }
  }

  /**
   * Restart the debugger.
   */
  async restart(): Promise<void> {
    if (this.isStarted) {
      await this.stop();
    }
    await this.start();

    // Re-send the breakpoints to the kernel and update the model.
    const { breakpoints } = this._model.breakpoints;
    for (const [source, points] of breakpoints) {
      await this._setBreakpoints(
        points.map(({ line }) => ({ line })),
        source
      );
    }
    this._model.breakpoints.restoreBreakpoints(breakpoints);
  }

  /**
   * Restore the state of a debug session.
   *
   * @param autoStart - If true, starts the debugger if it has not been started.
   * @param editorFinder - The editor finder instance.
   */
  async restoreState(
    autoStart: boolean,
    editorFinder?: IDebuggerEditorFinder
  ): Promise<void> {
    if (!this.model || !this.session) {
      return;
    }

    const reply = await this.session.restoreState();
    const { hashMethod, hashSeed, tmpFilePrefix, tmpFileSuffix } = reply.body;
    const breakpoints = this._mapBreakpoints(reply.body.breakpoints);
    const stoppedThreads = new Set(reply.body.stoppedThreads);

    this._setHashParameters(hashMethod, hashSeed);
    this._setTmpFileParameters(tmpFilePrefix, tmpFileSuffix);
    this._model.stoppedThreads = stoppedThreads;

    if (!this.isStarted && (autoStart || stoppedThreads.size !== 0)) {
      await this.start();
    }

    if (this.isStarted || autoStart) {
      this._model.title = this.isStarted ? this.session?.connection?.name : '-';
    }

    if (editorFinder) {
      const filtered = this._filterBreakpoints(breakpoints, editorFinder);
      this._model.breakpoints.restoreBreakpoints(filtered);
    } else {
      this._model.breakpoints.restoreBreakpoints(breakpoints);
    }

    if (stoppedThreads.size !== 0) {
      await this._getAllFrames();
    } else if (this.isStarted) {
      this._clearModel();
      this._clearSignals();
    }
  }

  /**
   * Continues the execution of the current thread.
   */
  async continue(): Promise<void> {
    try {
      await this.session.sendRequest('continue', {
        threadId: this._currentThread()
      });
      this._model.stoppedThreads.delete(this._currentThread());
    } catch (err) {
      console.error('Error:', err.message);
    }
  }

  /**
   * Makes the current thread run again for one step.
   */
  async next(): Promise<void> {
    try {
      await this.session.sendRequest('next', {
        threadId: this._currentThread()
      });
    } catch (err) {
      console.error('Error:', err.message);
    }
  }

  /**
   * Makes the current thread step in a function / method if possible.
   */
  async stepIn(): Promise<void> {
    try {
      await this.session.sendRequest('stepIn', {
        threadId: this._currentThread()
      });
    } catch (err) {
      console.error('Error:', err.message);
    }
  }

  /**
   * Makes the current thread step out a function / method if possible.
   */
  async stepOut(): Promise<void> {
    try {
      await this.session.sendRequest('stepOut', {
        threadId: this._currentThread()
      });
    } catch (err) {
      console.error('Error:', err.message);
    }
  }

  /**
   * Update all breakpoints at once.
   *
   * @param code - The code in the cell where the breakpoints are set.
   * @param breakpoints - The list of breakpoints to set.
   * @param path - Optional path to the file where to set the breakpoints.
   * @param editorFinder - The editor finder object
   */
  async updateBreakpoints(
    code: string,
    breakpoints: IDebugger.IBreakpoint[],
    path?: string,
    editorFinder?: IDebuggerEditorFinder
  ): Promise<void> {
    if (!this.session.isStarted) {
      return;
    }

    if (!path) {
      path = (await this._dumpCell(code)).body.sourcePath;
    }

    const state = await this.session.restoreState();
    const localBreakpoints = breakpoints.map(({ line }) => ({ line }));
    const remoteBreakpoints = this._mapBreakpoints(state.body.breakpoints);

    // Set the local copy of breakpoints to reflect only editors that exist.
    if (editorFinder) {
      const filtered = this._filterBreakpoints(remoteBreakpoints, editorFinder);
      this._model.breakpoints.restoreBreakpoints(filtered);
    } else {
      this._model.breakpoints.restoreBreakpoints(remoteBreakpoints);
    }

    // Set the kernel's breakpoints for this path.
    const reply = await this._setBreakpoints(localBreakpoints, path);
    const updatedBreakpoints = reply.body.breakpoints
      .map(val => ({ ...val, active: true }))
      .filter((val, _, arr) => arr.findIndex(el => el.line === val.line) > -1);

    // Update the local model and finish kernel configuration.
    this._model.breakpoints.setBreakpoints(path, updatedBreakpoints);
    await this.session.sendRequest('configurationDone', {});
  }

  /**
   * Clear all the breakpoints for the current session.
   */
  async clearBreakpoints(): Promise<void> {
    if (!this.session.isStarted) {
      return;
    }

    this._model.breakpoints.breakpoints.forEach(
      async (breakpoints, path, _) => {
        await this._setBreakpoints([], path);
      }
    );

    let bpMap = new Map<string, IDebugger.IBreakpoint[]>();
    this._model.breakpoints.restoreBreakpoints(bpMap);
  }

  /**
   * Retrieve the content of a source file.
   *
   * @param source The source object containing the path to the file.
   */
  async getSource(source: DebugProtocol.Source): Promise<IDebugger.ISource> {
    const reply = await this.session.sendRequest('source', {
      source,
      sourceReference: source.sourceReference
    });
    return { ...reply.body, path: source.path };
  }

  /**
   * Request variables for a given variable reference.
   *
   * @param variablesReference The variable reference to request.
   */
  async inspectVariable(
    variablesReference: number
  ): Promise<DebugProtocol.Variable[]> {
    const reply = await this.session.sendRequest('variables', {
      variablesReference
    });
    return reply.body.variables;
  }

  /**
   * Dump the content of a cell.
   *
   * @param code The source code to dump.
   */
  private async _dumpCell(
    code: string
  ): Promise<IDebugger.ISession.IDumpCellResponse> {
    return this.session.sendRequest('dumpCell', { code });
  }
  /**
   * Filter breakpoints and only return those associated with a known editor.
   *
   * @param breakpoints - Map of breakpoints.
   *
   * @param editorFinder - The editor finder object.
   */
  private _filterBreakpoints(
    breakpoints: Map<string, IDebugger.IBreakpoint[]>,
    editorFinder: IDebuggerEditorFinder
  ): Map<string, IDebugger.IBreakpoint[]> {
    const path = this._session.connection.path;
    const associatedBreakpoints = (
      remoteBreakpoints: Map<string, IDebugger.IBreakpoint[]>,
      editorFinder: IDebuggerEditorFinder
    ): string[] => {
      const associatedBreakpoints: string[] = [];
      for (const [key, value] of remoteBreakpoints) {
        each(editorFinder.find(path, key, false), () => {
          if (value.length > 0) {
            associatedBreakpoints.push(key);
          }
        });
      }
      return associatedBreakpoints;
    };

    const breakpointsForRestore = (
      breakpoints: Map<string, IDebugger.IBreakpoint[]>,
      editorFinder: IDebuggerEditorFinder
    ): Map<string, IDebugger.IBreakpoint[]> => {
      let bpMapForRestore = new Map<string, IDebugger.IBreakpoint[]>();
      associatedBreakpoints(breakpoints, editorFinder).forEach(path => {
        Array.from(breakpoints.entries()).forEach(value => {
          if (value[0] === path) {
            bpMapForRestore.set(value[0], breakpoints.get(value[0]));
          }
        });
      });
      return bpMapForRestore;
    };
    return breakpointsForRestore(breakpoints, editorFinder);
  }

  /**
   * Process the list of breakpoints from the server and return as a map.
   *
   * @param breakpoints - The list of breakpoints from the kernel.
   *
   */
  private _mapBreakpoints(
    breakpoints: IDebugger.ISession.IDebugInfoBreakpoints[]
  ): Map<string, IDebugger.IBreakpoint[]> {
    if (!breakpoints.length) {
      return new Map<string, IDebugger.IBreakpoint[]>();
    }
    return breakpoints.reduce(
      (
        map: Map<string, IDebugger.IBreakpoint[]>,
        val: IDebugger.ISession.IDebugInfoBreakpoints
      ) => {
        const { breakpoints, source } = val;
        map.set(
          source,
          breakpoints.map(point => ({ ...point, active: true }))
        );
        return map;
      },
      new Map<string, IDebugger.IBreakpoint[]>()
    );
  }

  /**
   * Get all the frames from the kernel.
   */
  private async _getAllFrames(): Promise<void> {
    this._model.callstack.currentFrameChanged.connect(
      this._onChangeFrame,
      this
    );
    this._model.variables.variableExpanded.connect(
      this._onVariableExpanded,
      this
    );

    const stackFrames = await this._getFrames(this._currentThread());
    this._model.callstack.frames = stackFrames;
  }

  /**
   * Handle a change of the current active frame.
   *
   * @param _ The callstack model
   * @param frame The frame.
   */
  private async _onChangeFrame(
    _: CallstackModel,
    frame: CallstackModel.IFrame
  ): Promise<void> {
    if (!frame) {
      return;
    }
    const scopes = await this._getScopes(frame);
    const variables = await this._getVariables(scopes[0]);
    const variableScopes = this._convertScopes(scopes, variables);
    this._model.variables.scopes = variableScopes;
  }

  /**
   * Handle a variable expanded event and request variables from the kernel.
   *
   * @param _ The variables model.
   * @param variable The expanded variable.
   */
  private async _onVariableExpanded(
    _: VariablesModel,
    variable: DebugProtocol.Variable
  ): Promise<DebugProtocol.Variable[]> {
    const reply = await this.session.sendRequest('variables', {
      variablesReference: variable.variablesReference
    });
    let newVariable = { ...variable, expanded: true };

    reply.body.variables.forEach((variable: DebugProtocol.Variable) => {
      newVariable = { [variable.name]: variable, ...newVariable };
    });
    const newScopes = this._model.variables.scopes.map(scope => {
      const findIndex = scope.variables.findIndex(
        ele => ele.variablesReference === variable.variablesReference
      );
      scope.variables[findIndex] = newVariable;
      return { ...scope };
    });

    this._model.variables.scopes = [...newScopes];
    return reply.body.variables;
  }

  /**
   * Get all the frames for the given thread id.
   *
   * @param threadId The thread id.
   */
  private async _getFrames(
    threadId: number
  ): Promise<DebugProtocol.StackFrame[]> {
    const reply = await this.session.sendRequest('stackTrace', {
      threadId
    });
    const stackFrames = reply.body.stackFrames;
    return stackFrames;
  }

  /**
   * Get all the scopes for the given frame.
   *
   * @param frame The frame.
   */
  private async _getScopes(
    frame: DebugProtocol.StackFrame
  ): Promise<DebugProtocol.Scope[]> {
    if (!frame) {
      return;
    }
    const reply = await this.session.sendRequest('scopes', {
      frameId: frame.id
    });
    return reply.body.scopes;
  }

  /**
   * Get the variables for a given scope.
   *
   * @param scope The scope to get variables for.
   */
  private async _getVariables(
    scope: DebugProtocol.Scope
  ): Promise<DebugProtocol.Variable[]> {
    if (!scope) {
      return;
    }
    const reply = await this.session.sendRequest('variables', {
      variablesReference: scope.variablesReference
    });
    return reply.body.variables;
  }

  /**
   * Set the breakpoints for a given file.
   *
   * @param breakpoints The list of breakpoints to set.
   * @param path The path to where to set the breakpoints.
   */
  private async _setBreakpoints(
    breakpoints: DebugProtocol.SourceBreakpoint[],
    path: string
  ): Promise<DebugProtocol.SetBreakpointsResponse> {
    return await this.session.sendRequest('setBreakpoints', {
      breakpoints: breakpoints,
      source: { path },
      sourceModified: false
    });
  }

  /**
   * Map a list of scopes to a list of variables.
   *
   * @param scopes The list of scopes.
   * @param variables The list of variables.
   */
  private _convertScopes(
    scopes: DebugProtocol.Scope[],
    variables: DebugProtocol.Variable[]
  ): VariablesModel.IScope[] {
    if (!variables || !scopes) {
      return;
    }
    return scopes.map(scope => {
      return {
        name: scope.name,
        variables: variables.map(variable => {
          return { ...variable };
        })
      };
    });
  }

  /**
   * Clear the current model.
   */
  private _clearModel(): void {
    this._model.callstack.frames = [];
    this._model.variables.scopes = [];
  }

  /**
   * Clear the signals set on the model.
   */
  private _clearSignals(): void {
    this._model.callstack.currentFrameChanged.disconnect(
      this._onChangeFrame,
      this
    );
    this._model.variables.variableExpanded.disconnect(
      this._onVariableExpanded,
      this
    );
  }

  /**
   * Get the current thread from the model.
   */
  private _currentThread(): number {
    // TODO: ask the model for the current thread ID
    return 1;
  }

  /**
   * Set the hash parameters for the current session.
   *
   * @param method The hash method.
   * @param seed The seed for the hash method.
   */
  private _setHashParameters(method: string, seed: number): void {
    if (method === 'Murmur2') {
      this._hashMethod = (code: string): string => {
        return murmur2(code, seed).toString();
      };
    } else {
      throw new Error('hash method not supported ' + method);
    }
  }

  /**
   * Set the parameters used for the temporary files (e.g. cells).
   *
   * @param prefix The prefix used for the temporary files.
   * @param suffix The suffix used for the temporary files.
   */
  private _setTmpFileParameters(prefix: string, suffix: string): void {
    this._tmpFilePrefix = prefix;
    this._tmpFileSuffix = suffix;
  }

  private _isDisposed = false;
  private _session: IDebugger.ISession;
  private _model: DebuggerModel;
  private _sessionChanged = new Signal<IDebugger, IDebugger.ISession>(this);
  private _modelChanged = new Signal<IDebugger, IDebugger.IModel>(this);
  private _eventMessage = new Signal<IDebugger, IDebugger.ISession.Event>(this);

  private _specsManager: KernelSpec.IManager;

  private _hashMethod: (code: string) => string;
  private _tmpFilePrefix: string;
  private _tmpFileSuffix: string;
}

/**
 * A namespace for `DebuggerService` statics.
 */
export namespace DebuggerService {
  /**
   * Instantiation options for a `DebuggerService`.
   */
  export interface IOptions {
    /**
     * The kernel specs manager.
     */
    specsManager: KernelSpec.IManager;
  }
}
