export interface ChannelAdapter {
  readonly platform: string;
  start(): Promise<void>;
}
