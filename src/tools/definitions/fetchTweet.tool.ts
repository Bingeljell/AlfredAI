import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { appConfig } from "../../config/env.js";

const InputSchema = z.object({
  url: z.string().url().describe("Full tweet URL (twitter.com or x.com/*/status/*)")
});

function extractTweetId(url: string): string | null {
  return url.match(/\/status\/(\d+)/)?.[1] ?? null;
}

export const toolDefinition: ToolDefinition<typeof InputSchema> = {
  name: "fetch_tweet",
  description:
    "Fetch a tweet via the Twitter API v2 and return its raw content: text, author, metrics, and thread context. Requires TWITTER_BEARER_TOKEN. If unavailable, use pinchtab_fetch instead.",
  inputSchema: InputSchema,
  inputHint: '{"url":"https://x.com/user/status/1234567890"}',

  async execute(input) {
    if (!appConfig.twitterBearerToken) {
      return {
        error: "TWITTER_BEARER_TOKEN not configured — use pinchtab_fetch or web_fetch instead"
      };
    }

    const tweetId = extractTweetId(input.url);
    if (!tweetId) {
      return { error: `Could not extract tweet ID from URL: ${input.url}` };
    }

    const apiUrl =
      `https://api.twitter.com/2/tweets/${tweetId}` +
      `?expansions=author_id,attachments.media_keys,referenced_tweets.id` +
      `&tweet.fields=text,created_at,public_metrics,entities,conversation_id,referenced_tweets` +
      `&user.fields=name,username,description` +
      `&media.fields=type,url,alt_text`;

    const res = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${appConfig.twitterBearerToken}` },
      signal: AbortSignal.timeout(10_000)
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { error: `Twitter API ${res.status}: ${body.slice(0, 200)}` };
    }

    const data = await res.json() as Record<string, any>;
    const tweet = data.data as Record<string, any>;
    const includes = data.includes as Record<string, any> ?? {};
    const author = (includes.users as any[])?.[0] as Record<string, any> | undefined;
    const media = includes.media as any[] | undefined;

    return {
      tweetId,
      text: tweet.text as string,
      author: author
        ? { username: author.username as string, name: author.name as string, bio: author.description as string ?? "" }
        : null,
      createdAt: tweet.created_at as string ?? null,
      metrics: tweet.public_metrics
        ? {
            likes: (tweet.public_metrics as any).like_count as number,
            retweets: (tweet.public_metrics as any).retweet_count as number,
            replies: (tweet.public_metrics as any).reply_count as number,
            quotes: (tweet.public_metrics as any).quote_count as number
          }
        : null,
      conversationId: tweet.conversation_id as string ?? null,
      hasMedia: Array.isArray(media) && media.length > 0,
      mediaTypes: Array.isArray(media) ? (media as any[]).map((m: any) => m.type as string) : [],
      referencedTweets: Array.isArray(tweet.referenced_tweets)
        ? (tweet.referenced_tweets as any[]).map((r: any) => ({ type: r.type as string, id: r.id as string }))
        : []
    };
  }
};
