import { BadRequestException } from "@nestjs/common";

/** Checks a text field of a contest request. */
export function text(value: unknown, limit: number, required = false): string {
  if (typeof value !== "string" || value.length > limit || (required && !value.trim()))
    throw new BadRequestException("Invalid text");
  return value;
}

/** Checks a file name of a contest request: an attachment's, or a problem's input or output file. */
export function filename(value: unknown): string {
  const name = text(value ?? "", 120);
  if (name && (!/^[\p{L}\p{N}_. -]+$/u.test(name) || name === "." || name === ".."))
    throw new BadRequestException("Invalid filename");
  return name;
}
