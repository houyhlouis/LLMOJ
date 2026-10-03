import type { AiStatementText } from "./ai.types";

/** The private transport must not change the value returned through a typed public API. */
export const AI_GRADER_BRIDGE_RULES =
  "For function/grader mode, distinguish exact typed return values from whitespace-delimited contestant text. The shared plan protocolDescription MUST specify the complete private bridge framing for every public function/callback input and return, and both manager and grader MUST implement that same framing. Serialize every string or byte array with an explicit byte length and exactly that many raw bytes, or an equally unambiguous lossless encoding; state the separators and EOF rules. Decode the exact length without dropping any bytes, including leading/trailing spaces, tabs, newlines and NUL. Never use operator>> token extraction, trim, split, strlen, or canonicalization to carry typed string values. Apply original alphabet and length constraints to the actual complete function return value, and independently to the decoded value in the manager, before accepting or forwarding it to the other process. For a nonempty binary string of at most 16 bytes, any whitespace/NUL byte or a 17-byte value is invalid even when trimming would produce a valid string. Check length bounds before allocation, reject truncated frames, malformed lengths and extra payload. Preserve exact public function signatures and public header names; only the private bridge may change. General whitespace/numeric-spelling tolerance applies to ordinary textual protocol fields, NEVER to the contents or length of a typed string. Do not expose hidden truth to the decoder or embed it in the grader.";

/** Keep a model's public API description bounded and preserve its exact C++ signatures. */
export function normalizeAiPublicInterface(value: unknown): string | null {
  if (typeof value === "string") return value.trim() && Buffer.byteLength(value) <= 32768 ? value : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const spec = value as Record<string, unknown>;
  const serialized = JSON.stringify(spec);
  if (Buffer.byteLength(serialized) > 32768) return null;
  // Earlier plans reasonably returned a structured interface because the prompt omitted its type.
  // Accept that precise form on resume; an arbitrary object must not masquerade as a public API.
  const validFunction = (entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const fn = entry as Record<string, unknown>;
    return (
      typeof fn.name === "string" &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(fn.name) &&
      typeof fn.signature === "string" &&
      fn.signature.length <= 4096 &&
      /\([^]*\)/.test(fn.signature)
    );
  };
  if (
    !Array.isArray(spec.functions) ||
    !spec.functions.length ||
    spec.functions.length > 64 ||
    !spec.functions.every(validFunction)
  )
    return null;
  if (
    spec.callbacks != null &&
    (!Array.isArray(spec.callbacks) || spec.callbacks.length > 64 || !spec.callbacks.every(validFunction))
  )
    return null;
  const headers = spec.publicHeaderFilenames ?? (typeof spec.header === "string" ? [spec.header] : []);
  if (
    !Array.isArray(headers) ||
    headers.length > 16 ||
    headers.some(
      name => typeof name !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:h|hpp)$/.test(name) || name.includes("..")
    )
  )
    return null;
  return serialized;
}

/** Only explicit statement declarations authorize publishing an existing private header. */
export function declaredAiPublicHeaderNames(statements: AiStatementText[]): string[] {
  const names = new Set<string>();
  for (const statement of statements || [])
    for (const section of statement.contentSections || []) {
      if (section.type !== "Text") continue;
      const prose = String(section.text || "").replace(/(`{3,}|~{3,})[\s\S]*?\1/g, "");
      const pattern =
        /(?:public\s+(?:api\s+)?headers?|公共头文件|公开头文件)\s*(?:named\s+|called\s+|为\s*|是\s*|[:：]\s*)?[`"']?([A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:h|hpp))\b/gi;
      for (const match of prose.matchAll(pattern)) if (!match[1].includes("..")) names.add(match[1]);
    }
  return [...names];
}
