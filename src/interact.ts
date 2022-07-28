// This file snarfs some code from https://pastebin.com/raw/CAUAB7RM
// (see the discussion here
// https://codereview.stackexchange.com/questions/219567/communication-with-interactive-program-using-childprocess).

import { exec, ChildProcess } from 'child_process';
import { write } from 'fs';
import { EventEmitter } from 'events';

const Debugger_commands = {
    //cd: (dir: string) => `cd "${dir}"`,
    //run: () => 'run',
    quit: () => 'quit',
}

interface CancellableHandler<T> {
    promise: Promise<T>;
    cancel: () => void;
}

// Resolves or rejects with 'promise' or, rejects with an error on
// timeout (never times out if 'ms' is 0).
function waitForPromiseOrTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timeout: NodeJS.Timeout;
    const timeoutPromise = new Promise<T>((_, reject) => {
        timeout = setTimeout(() => (ms > 0) ? reject(() => { return new Error("timeout") }) : null, ms);
    });
    promise.finally(() => clearTimeout(timeout));

    return Promise.race([timeoutPromise, promise]);
}

// Resolves or rejects with the promise of the first handler to finish
// or rejects with an error on timeout (if 'ms' > 0).
function raceForCancellableHandlersOrTimeout(ms: number, ...handlers: CancellableHandler<any>[]): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => (ms > 0) ? reject(() => { return new Error("timeout") }) : null, ms);
    });
    handlers.forEach(p => p.promise.finally(() => {
        if (timeout) {
            handlers.forEach(h => h.cancel());
            clearTimeout(timeout);
            timeout = undefined;
        }
    }));

    return Promise.race([timeoutPromise, ...(handlers.map(h => h.promise))]);
}

// Create an object that satisfies the `CancellableHandler<T>`
// interface which resolves when the provided event name fires. The
// promise is resolved with the first argument passed by the event
// emitter.
function cancellableEventHandler<T = any>(emitter: EventEmitter, eventName: string, errorFactory?: (...args: any[]) => Error): CancellableHandler<T> {
    let cancel: () => void = () => null;
    const promise = new Promise<T>((resolve, reject) => {
        const handler = errorFactory ? ((...args: any[]) => reject(errorFactory(...args))) : (arg: T) => resolve(arg);
        emitter.once(eventName, handler);
        cancel = () => emitter.removeListener(eventName, handler);
    });

    return {cancel, promise};
}

// Waits for 'eventName' to happen and resolves with the first
// argument passed to the 'eventName' callback or rejects if the
// timeout happes first.
async function waitForEventOrTimeout<T = any>(emitter: EventEmitter, eventName: string, timeoutMs: number) {
    const awaiter = cancellableEventHandler(emitter, eventName);

    if (timeoutMs === 0) {
        return awaiter.promise;
    }

    try {
        return await waitForPromiseOrTimeout<T>(awaiter.promise, timeoutMs);
    } finally {
        awaiter.cancel();
    }
}

interface Events {
    [key: string]: string;
}

export const Debugger_events : Events = {
    console_data: 'console:data',
    console_error: 'console.error',
    console_write: 'console.write',

    ocd_change_directory: 'ocd:change_directory',
    ocd_stop: 'ocd:stop',
}
export class Ocd extends EventEmitter {
    private _ocdPath = "/Users/shaynefletcher/.opam/default/bin/ocamldebug";
    private _process ?: ChildProcess = undefined;
    private _running = false;
    private _initialized = false;

    // Waits for 'eventName' to happen and resolves with the first
    // argument passed to the 'eventName' callback or rejects when
    // timeout happens first.
    public async waitForEventOrTimeout<T>(eventName: string, ms: number) {
        return waitForEventOrTimeout<T>(this, eventName, ms);
    }

    public async start(timeoutMs: number = 60000) {
        if (this._process) {
            await this.stop(timeoutMs);
        }
        console.log("ocd starting");
        this._running = false;
        this._initialized = false;
        this._process = exec(this._ocdPath + " " + "-no-version" + " " + "/Users/shaynefletcher/tmp/uncaught/uncaught");
        this._process.on("error", this.onError);
        this._process.on("exit", this.onExit)
        this._process.stdout?.on("data", this.onData);
        this._process.stdout?.on("data", (data) => {
            const str = String(data).trim();
            if (str.length > 0) {
                this.emit(Debugger_events.console_data, str);
            }
        });
        this._process.stderr?.on("data", (data) => {
            const str = String(data).trim();
            if (str.length > 0) {
                this.emit(Debugger_events.console_error, str);
            }
        });

        if (timeoutMs > 0) {
            await this.waitUntilInitialized(timeoutMs);
        }
    }

    public async stop(timeoutMs: number = 60000) {
        if (! this._process) {
            return;
        }

        await this.writeLn(Debugger_commands.quit());

        try {
            await this.waitForEventOrTimeout(Debugger_events.ocd_stop, timeoutMs);
        } catch(e) {
            console.warn("Unable to gracefully terminate ocamldebug: ", e);
            if (this._process) {
                this._process.kill();
                try {
                    await this.waitForEventOrTimeout(Debugger_events.ocd_stop, 1000);
                } catch(e) {
                    console.error("Unable to terminate ocamldebug: ", e)
                }
            }
        }

    }

    private async waitUntilInitialized(timeoutMs: number) {
        if (! this._process) {
            throw (new Error("ocaml_debug not running")) ;
        }

        if (this._initialized) {
            return;
        }

        const exitAwaiter = cancellableEventHandler(this._process, "exit", () => { return new Error("ocamldebug not running") });
        const dataAwaiter = cancellableEventHandler(this, Debugger_events.ocd_initialized);

        await raceForCancellableHandlersOrTimeout(timeoutMs, exitAwaiter, dataAwaiter);
    }

    private onError = (err: any) => {
        console.warn("ocamldebug error: ", err);
    }

    private onExit = (code: number, signal: string) => {
        if (code !== 0) {
            console.warn("ocamldebug: exit code(", code, "), signal(", signal, ")");
        }

        this._process = undefined;
        this._running = false;
        this._initialized = false;
        this.emit(Debugger_events.ocd_stop);
    }

    private onData = (data: any) => {
        type Resolver<T> = {
            eventName: string,
            args?: (data: T) => any[],
        } | ((data: T) => void);

        interface ValueHandlerString {
            key: string;
            resolver: Resolver<string>;
        }

        const valueHandlers: Array<ValueHandlerString> = [
            { key: '(ocd)', resolver: () => {
                if (! this._initialized) {
                    this._initialized = true;
                    this.emit(Debugger_events.ocd_initialized);
                }
            }},
        ];

        const callResolver = <T>(resolver: Resolver<T>, arg: T) => {
            if (typeof resolver === 'function') {
                resolver(arg);
            } else {
                const args = resolver.args ? resolver.args(arg) :  [];
                this.emit(resolver.eventName, ...args);
            }
        }

        const lines = String(data).split("\n").map(line => line.trim()).filter(line => line.length > 0);

        lines.forEach(line => {
            let handled = false;
            for (const handler of valueHandlers) {
                if (line == handler.key) {
                    callResolver((handler as ValueHandlerString).resolver, line);
                    handled = true;
                }
            }
            if (! handled) {
                console.warn("Unhandled line", line);
            }
        });
    }

    private async writeLn(value: string) {
        return new Promise<void>((resolve, reject) => {
            if (! this._process) {
                return reject(() => { return new Error("process not running") });
            }
            this._process.stdin?.write(value + "\n", (err) => {
                if (err) {
                    return reject(err);
                }
                this.emit(Debugger_events.console_write, value + "\n");
                resolve();
            })
        });
    }
}

const test = async () => {
    const ocd = new Ocd();
    try {
        ocd.on(Debugger_events.console_write, data => console.log(data));
        ocd.on(Debugger_events.console_error, data => console.log("E:", data));
        ocd.on(Debugger_events.ocd_initialized, data => console.log("initialized"));
        ocd.on(Debugger_events.ocd_stop, data => console.log("stopped"));
        await ocd.start();
    } finally {
        await ocd.stop();
    }
}

test().then(() => console.log("Finished"), (err) => console.error("Error", err));
