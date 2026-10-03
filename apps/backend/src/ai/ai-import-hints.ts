import { AiError } from "./ai.types";
import { resolveAiFileIo } from "./ai-file-io";

export function parseAiImportHints(text: string) {
  const value: {
    timeLimit?: number;
    memoryLimit?: number;
    fileIo?: { inputFilename: string; outputFilename: string } | null;
  } = {};
  const time = text.match(
    /(?:^|[\n;；])\s*(?:time\s*limit|时间限制)\s*[:：=]\s*(\d+(?:\.\d+)?)[ \t]*(milliseconds?|ms|毫秒|秒|s(?:ec(?:onds?)?)?)?/im
  );
  if (time) {
    const n = Number(time[1]);
    const unit = (time[2] || "").toLowerCase();
    value.timeLimit = Math.round(
      n * (unit === "ms" || unit === "毫秒" || unit.startsWith("millisecond") ? 1 : unit || n <= 60 ? 1000 : 1)
    );
    if (value.timeLimit < 1 || value.timeLimit > 60000) throw new AiError("INVALID_AI_RESOURCE_LIMITS");
  }
  const memory = text.match(
    /(?:^|[\n;；])\s*(?:memory\s*limit|空间限制|内存限制)\s*[:：=]\s*(\d+(?:\.\d+)?)\s*(gib|gb|mib|mb|kib|kb|g|m|k)?\b/im
  );
  if (memory) {
    const unit = (memory[2] || "mb").toLowerCase();
    value.memoryLimit = Math.round(
      Number(memory[1]) * (unit.startsWith("g") ? 1024 : unit.startsWith("k") ? 1 / 1024 : 1)
    );
    if (value.memoryLimit < 1 || value.memoryLimit > 4096) throw new AiError("INVALID_AI_RESOURCE_LIMITS");
  }
  const io = text.match(/(?:^|[\n;；])\s*file\s*io\s*[:：=]\s*`?([^\s`;,；]+)/im);
  if (io) {
    if (/^(?:stdio|standard|none|null)$/i.test(io[1])) value.fileIo = null;
    else {
      const base = io[1];
      if (!/^[A-Za-z0-9_.-]+$/.test(base) || base === "." || base === "..") throw new AiError("INVALID_AI_FILE_IO");
      value.fileIo = { inputFilename: `${base}.in`, outputFilename: `${base}.out` };
      resolveAiFileIo({ fileIo: value.fileIo }, []);
    }
  }
  return value;
}
