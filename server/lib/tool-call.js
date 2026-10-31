/**
 * Some local models (Qwen coder variants in particular) return a tool call as
 * plain JSON content instead of filling the OpenAI `tool_calls` array. Detect
 * that shape so the agent executes the tool instead of showing raw JSON.
 */
export function toolCallFromContent(content) {
  let text = String(content ?? '').trim();
  if (!text) return null;

  // Strip a fenced code block around the object.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!text.startsWith('{')) return null;

  const parse = (value) => {
    try {
      const obj = JSON.parse(value);
      if (!obj || typeof obj !== 'object') return null;
      const name = obj.name ?? obj.tool ?? obj.function?.name;
      let args = obj.arguments ?? obj.parameters ?? obj.function?.arguments ?? {};
      if (typeof name !== 'string' || !name) return null;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
      return { name, arguments: args };
    } catch {
      return null;
    }
  };

  const direct = parse(text);
  if (direct) return direct;

  // Tolerate leading prose before the object.
  const match = /\{[\s\S]*\}/.exec(text);
  return match ? parse(match[0]) : null;
}
