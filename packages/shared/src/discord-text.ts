/**
 * Text someone typed — a player's name, a chat line, a reason — put into a Discord message as
 * written.
 *
 * Discord reads message text as formatting, so typed text dropped in raw is reformatted: a name
 * "*ABC* Smith" lost its asterisks to italics, one with an underscore or a backtick garbled its
 * line, and "[free VIP](https://…)" posted as a link whose words hid where it went. CRCON escapes
 * the same text before it sends it (discord.utils.escape_markdown).
 *
 * Lives in shared because the bot's relay and the API's own Discord messages (approval cards, the
 * staff and member panels) both write typed text into Discord.
 */

/** A web address inside typed text, kept whole so a link still opens, and opens what it shows. */
const WEB_ADDRESS = /https?:\/\/[^\s<>]+/g;

/** `text` with Discord's formatting characters escaped, web addresses left whole. */
export function discordLiteral(text: string): string {
  const escape = (part: string) => part.replace(/[\\*_~`|[\]]/g, "\\$&");
  let out = "";
  let last = 0;
  for (const m of text.matchAll(WEB_ADDRESS)) {
    out += escape(text.slice(last, m.index)) + m[0];
    last = (m.index ?? 0) + m[0].length;
  }
  return out + escape(text.slice(last));
}
