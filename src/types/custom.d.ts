/* eslint-disable */
declare module '*.svg' {
  const content: any;
  export default content;
}

declare module '*.jpg' {
  const content: any;
  export default content;
}
declare module '*.jpeg' {
  const content: any;
  export default content;
}

declare module '*.gif' {
  const content: any;
  export default content;
}

declare module '*.png' {
  const content: any;
  export default content;
}

declare module '*.css' {
  interface IClassNames {
    [className: string]: string;
  }
  const classNames: IClassNames;
  export = classNames;
}
interface JelliumHostV1 {
  readonly protocolVersion: 1;
  readonly hostName: 'jellium-desktop';
  readonly hostVersion: string;
  readonly capabilities: readonly string[];
  requestAuthChallenge(requestId: string): boolean;
  playItem(requestId: string, itemId: string): boolean;
  completeAuth(requestId: string, ticket: string): boolean;
  clearSession(requestId: string): boolean;
  minimize(): boolean;
  toggleMaximize(): boolean;
  toggleFullscreen(): boolean;
  quit(): boolean;
}

interface Window {
  readonly jelliumHost?: JelliumHostV1;
}
