import { BadRequestException } from "@nestjs/common";

import { CodeLanguage } from "../code-language/code-language.type";
import { CPP_STANDARDS } from "../code-language/compile-and-run-options/cpp";
import { PYTHON_VERSIONS } from "../code-language/compile-and-run-options/python";

const variants: Partial<Record<CodeLanguage, string[]>> = {
  [CodeLanguage.Cpp]: CPP_STANDARDS,
  [CodeLanguage.Python]: PYTHON_VERSIONS
};
const supported = Object.values(CodeLanguage).flatMap(language =>
  variants[language] ? variants[language].map(version => `${language}:${version}`) : [language]
);

// Expand legacy all-version entries while storing one unambiguous choice per version.
export function normalizeContestLanguages(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) throw new BadRequestException("Invalid languages");
  return [
    ...new Set(
      value.flatMap(language => {
        if (typeof language !== "string") throw new BadRequestException("Invalid languages");
        if (Object.prototype.hasOwnProperty.call(variants, language))
          return variants[language].map(version => `${language}:${version}`);
        if (!supported.includes(language)) throw new BadRequestException("Invalid languages");
        return [language];
      })
    )
  ];
}

export function isContestLanguageAllowed(
  allowed: string[],
  language: string,
  options: Record<string, unknown>
): boolean {
  if (!Object.values(CodeLanguage).includes(language as CodeLanguage)) return false;
  const version =
    language === CodeLanguage.Cpp ? options?.std : language === CodeLanguage.Python ? options?.version : null;
  if (variants[language] && !variants[language].includes(version)) return false;
  return allowed.includes(language) || (typeof version === "string" && allowed.includes(`${language}:${version}`));
}
