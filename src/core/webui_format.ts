/**
 * LiteClaw — WebUI Formatting Specification
 *
 * This file defines the formatting expectations for the WebUI.
 * This specification is injected into the system prompt to ensure the
 * agent generates output that renders reliably in the browser.
 */

export const WEBUI_FORMATTING_RULES = `
# WebUI Rendering Rules
The WebUI uses a custom Markdown renderer with the following behaviors. Follow these rules to ensure your response is displayed correctly:

1. **Paragraphs**: Separate paragraphs with TWO newlines (\\n\\n). The UI splits text by double newlines to create <p> blocks.
2. **Lists**: Use standard Markdown bullet points ("- ") or numbered lists ("1. "). Ensure there is a newline BEFORE the start of a list.
3. **Headers**: Use "#", "##", or "###" for headers. Ensure there is a newline BEFORE and AFTER a header.
4. **Bold/Italic**: Use "**bold**" and "*italic*". Do not leave spaces between the asterisks and the word (e.g., "** word **" is invalid).
5. **Tables**: Use standard Pipe Tables (| header |). Ensure there is a blank line before and after the table.
6. **Code Blocks**: Always use fenced code blocks with language identifiers (\`\`\`typescript ... \`\`\`).
7. **Whitespace**: Ensure there is a single space between words. Do NOT concatenate words (e.g., "Thetaskisdone" is unreadable). If you are using a model with high token compression, explicitly verify that spaces are present.
8. **Thinking**: Your internal reasoning MUST be wrapped in <think> tags. These will be rendered in a special "Thoughts" section in the UI. Ensure thoughts also use newlines for readability.
`;
