import { v4 as uuid } from 'uuid';
import { OpenTab, SFTab } from '../tabs';
import setupBroker from './broker';

interface ActionResponse {
  actionId: string;
  payload: any;
}

interface Action {
  id: string;
  action: string;
  payload: any;
}

/**
 * Mutable data we need to keep track of. Lesser the better.
 */
interface State {
  // All the tabs open in browser at any time. Assumption is that this list is
  // created when Emacs first connects, and then kept up-to-date by browser
  // itself whenever anything related to a tab changes
  openTabs: { [id: string]: OpenTab };
  // All tabs which are saved in Emacs. We obtain this list when Emacs first
  // connects. After that, any time something related to saved tabs changes,
  // this list should be updated *after the face*. i.e make the change in Emacs,
  // and then ask Emacs how this list looks like; either by asking for the whole
  // list again, or designing the response such that Emacs returns the updated
  // `SFTab`
  savedTabs: { [id: string]: SFTab };
}

/**
 * Events known to Spookfox.
 * For documentation and ease of refactoring.
 */
export enum SFEvents {
  // Emacs sends a CONNECTED request when it connects. Browser don't tell
  // us when it is able to connect to the native app. I suppose it is implicit
  // that if it don't disconnects, it connects. Sounds like ancient wisdom.
  EMACS_CONNECTED = 'EMACS_CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  // A request (aka Action) Emacs sent to do something or to provide
  // some information
  REQUEST = 'REQUEST',
  // Response Emacs sent for a request we made
  RESPONSE = 'RESPONSE',
  // Spookfox has had a state change, and new state is available
  NEW_STATE = 'NEW_STATE',
}

/**
 * A custom event which has an optional payload attached.
 */
export class SFEvent<P = any> extends Event {
  constructor(public name: string, public payload?: P) {
    super(name);
  }
}

/**
 * `Spookfox` is the heart of this addon.
 * # Usage
 * It should be used to
 * 1. Make a request to Emacs
 * ```
 * const sf = new Spookfox();
 * const savedTabs = sf.request('GET_SAVED_TABS');
 * ```
 *
 * 2. Run a function when Emacs makes a request
 * ```
 * const sf = new Spookfox();
 * sf.registerAction('OPEN_TAB', ({ url }) => {
 *   // somehow open a new tab with `url` provided by Emacs.
 * })
 * ```
 *
 * 3. Change the state
 * ```
 * const sf = new Spookfox();
 * const newState = { ... };
 * sf.newState(newState);
 * ```
 * Spookfox.state should be treated as immutable and shouldn't be modified in-place.
 * Instead, use `Spookfox.newState(s: State)` to replace existing state as a whole.
 *
 * # Events
 * It emits `SFEvents`. `SFEvents.REQUEST` and `SFEvents.RESPONSE` don't
 * need to be handled manually. `Spookfox.request` and `Spookfox.registerAction`
 * should be sufficient for most cases.
 */
// It extends `EventTarget` so we can have the ability to emit and listen to
// custom events. We rely on custom events to build independent modules, while
// providing a unified interface.
export class Spookfox extends EventTarget {
  port: browser.runtime.Port;
  state: State = {
    openTabs: {},
    savedTabs: {},
  };
  executioners = {};

  constructor(port?: browser.runtime.Port) {
    super();
    this.port = port || browser.runtime.connectNative('spookfox');

    setupBroker(this);
    this.setupRequestHandler();
    this.setupResponseHandler();
  }

  /**
   * A convenience function for sending a request with NAME and PAYLOAD to Emacs.
   * Returns a promise of response returned by Emacs.
   */
  request(name: string, payload?: object) {
    const action = {
      id: uuid(),
      action: name,
      payload,
    };

    this.port.postMessage(action);

    return this.getResponse(action.id);
  }

  /**
   * A convenience function for dispatching new events to `Spookfox`.
   */
  dispatch(name: string, payload?: object) {
    this.dispatchEvent(new SFEvent(name, payload));
  }

  registerAction(
    name: string,
    executioner: (payload: any, sf: Spookfox) => object
  ) {
    if (this.executioners[name]) {
      throw new Error(
        `Action already registered. There can only by one executioner per action. [action=${name}]`
      );
    }

    this.executioners[name] = executioner;
  }

  newState(s: State) {
    this.state = s;
    this.dispatch(SFEvents.NEW_STATE, s);
  }

  /**
   * Handle `SFEvents.REQUEST` events.
   * Calling this is critical for processing any requests received from Emacs.
   */
  private setupRequestHandler = async () => {
    this.addEventListener(SFEvents.REQUEST, async (e: SFEvent<Action>) => {
      const action = e.payload;
      const executioner = this.executioners[action.action];

      if (!executioner) {
        console.warn(
          `No executioner for action [action=${JSON.stringify(action)}]`
        );
        return;
      }
      const response = await executioner(action.payload, this);

      return this.port.postMessage({
        actionId: action.id,
        payload: response,
      });
    });
  };

  /**
   * Handle `SFEvents.RESPONSE` events.
   * Calling this is critical for getting responses for any requests sent to
   * Emacs.
   */
  private setupResponseHandler() {
    this.addEventListener(SFEvents.RESPONSE, (e: SFEvent<ActionResponse>) => {
      const res = e.payload;

      if (!res.actionId) {
        throw new Error(`Invalid response: [res=${res}]`);
      }

      // Dispatch a unique event per actionId. Shenanigans I opted for doing
      // to build a promise based interface on request/response dance needed
      // for communication with Emacs. Check `Spookfox.getResponse`
      this.dispatch(res.actionId, res.payload);
    });
  }

  private getResponse(actionId: string) {
    // FIXME: It is possible that this promise will never resolve, if for some
    // reason Emacs failed to respond. We should probably add a timeout here to
    // reject the promise if we don't get a response in X time
    return new Promise((resolve) => {
      const listener = (event: SFEvent) => {
        this.removeEventListener(actionId, listener);

        resolve(event.payload);
      };

      this.addEventListener(actionId, listener);
    });
  }
}