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
interface ForeseerNativeCommandV1 {
  id: string;
  type: string;
  ticket?: string;
  itemId?: string;
  url?: string;
  allowHttp?: boolean;
}

interface ForeseerNativeV1 {
  readonly protocolVersion: 1;
  readonly hostName: 'foreseer-desktop';
  readonly hostVersion: string;
  readonly capabilities: readonly string[];
  send(command: ForeseerNativeCommandV1): boolean;
}

interface Window {
  readonly foreseerNative?: ForeseerNativeV1;
}
