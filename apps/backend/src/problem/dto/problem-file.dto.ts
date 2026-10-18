export class ProblemFileDto {
  uuid: string;

  filename: string;

  size?: number;

  // The content's SHA-256, if recorded
  sha256?: string;
}
