export interface ChannelAdapter {
  readonly platform: string;
  start(): Promise<void>;
}

// ─── Channel attachments (multimodal) ───────────────────────────────────────

/**
 * Image attachment. Carries optional pixel dimensions when the channel can
 * report them (Telegram photo sizes, web UI EXIF, etc.). The blob itself is
 * identified by `blobId` and resolved through the blob store.
 */
export interface ChannelImageAttachment {
  kind: "image";
  blobId: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
}

/**
 * Voice note attachment. Semantically distinct from `audio` (it is a
 * push-to-talk bubble that expects a voice reply) but uses the same
 * underlying media. Duration is in seconds.
 */
export interface ChannelVoiceAttachment {
  kind: "voice";
  blobId: string;
  mime: string;
  size: number;
  durationSeconds?: number;
}

/**
 * Generic audio attachment (music clip, podcast snippet, sound effect). The
 * `audio` kind is the catch-all for non-voice audio. Duration is in seconds.
 */
export interface ChannelAudioAttachment {
  kind: "audio";
  blobId: string;
  mime: string;
  size: number;
  durationSeconds?: number;
}

/**
 * Video attachment. Carries optional pixel dimensions when the channel
 * reports them.
 */
export interface ChannelVideoAttachment {
  kind: "video";
  blobId: string;
  mime: string;
  size: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
}

/**
 * Document attachment (PDF, DOCX, plain text, etc.). `filename` is what the
 * sending client reported; it is metadata only and not used to resolve the
 * blob.
 */
export interface ChannelDocumentAttachment {
  kind: "document";
  blobId: string;
  mime: string;
  size: number;
  filename?: string;
}

/**
 * URL attachment whose fetched representation has been frozen in the blob
 * store. `url` preserves the source identity while `blobId` keeps resolver
 * input content-addressed like every other attachment variant.
 */
export interface ChannelUrlAttachment {
  kind: "url";
  blobId: string;
  mime: string;
  size: number;
  url: string;
  title?: string;
}

/**
 * Discriminated union of all attachments a channel can deliver to Alfred.
 * Every variant that carries media references it by `blobId` against the
 * shared blob store — no variant carries inline bytes.
 */
export type ChannelAttachment =
  | ChannelImageAttachment
  | ChannelVoiceAttachment
  | ChannelAudioAttachment
  | ChannelVideoAttachment
  | ChannelDocumentAttachment
  | ChannelUrlAttachment;
