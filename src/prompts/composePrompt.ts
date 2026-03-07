export interface PromptSection {
  label: string;
  content: string;
}

function normalizeBlock(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

export function composeSystemPrompt(sections: PromptSection[]): string {
  const blocks = sections
    .map((section) => ({
      label: section.label.trim(),
      content: normalizeBlock(section.content)
    }))
    .filter((section) => section.label.length > 0 && section.content.length > 0)
    .map((section) => `[${section.label}]\n${section.content}`);

  return blocks.join("\n\n");
}
