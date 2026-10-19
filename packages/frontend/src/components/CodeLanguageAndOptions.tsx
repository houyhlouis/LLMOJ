import React, { useEffect, useRef } from "react";
import { Form } from "semantic-ui-react";
import { observer } from "mobx-react";

import { useLocalizer } from "@/utils/hooks";
import {
  compileAndRunOptions,
  CodeLanguageOptionType,
  CodeLanguage,
  getPreferredCompileAndRunOptions
} from "@/interfaces/CodeLanguage";

interface CodeLanguageAndOptionsProps {
  pending?: boolean;
  allowedLanguages?: CodeLanguage[];
  allowedVariants?: string[];
  elementAfterLanguageSelect?: React.ReactNode;
  headerForLanguage?: string;
  classNameForLanguage?: string;
  classNameForCompileAndRunOptions?: string;
  language: CodeLanguage;
  compileAndRunOptions: Record<string, unknown>;
  onUpdateLanguage: (newLanguage: CodeLanguage) => void;
  onUpdateCompileAndRunOptions: (newCompileAndRunOptions: Record<string, unknown>) => void;
}

let CodeLanguageAndOptions: React.FC<CodeLanguageAndOptionsProps> = props => {
  const _ = useLocalizer("code_language");

  const compileAndRunOptionsBackup = useRef(new Map<CodeLanguage, Record<string, unknown>>()).current;
  function permittedValues(language: CodeLanguage, name: string, values: string[]) {
    if (
      !props.allowedVariants ||
      props.allowedVariants.includes(language) ||
      !((language === CodeLanguage.Cpp && name === "std") || (language === CodeLanguage.Python && name === "version"))
    )
      return values;
    return values.filter(value => props.allowedVariants.includes(language + ":" + value));
  }
  useEffect(() => {
    if (!props.allowedVariants?.length || props.pending) return;
    const allowed = [...new Set(props.allowedVariants.map(value => value.split(":")[0]))],
      language = (allowed.includes(props.language) ? props.language : allowed[0]) as CodeLanguage,
      next =
        language === props.language ? { ...props.compileAndRunOptions } : getPreferredCompileAndRunOptions(language);
    for (const option of compileAndRunOptions[language]) {
      const values = permittedValues(language, option.name, option.values);
      if (values.length && !values.includes(next[option.name] as string)) next[option.name] = values[0];
    }
    if (language !== props.language) props.onUpdateLanguage(language);
    if (JSON.stringify(next) !== JSON.stringify(props.compileAndRunOptions)) props.onUpdateCompileAndRunOptions(next);
  }, [props.allowedVariants?.join(","), props.language, props.pending]);
  function onSwitchLanguage(newLanguage: CodeLanguage) {
    const oldLanguage = props.language;
    compileAndRunOptionsBackup.set(oldLanguage, props.compileAndRunOptions);
    props.onUpdateLanguage(newLanguage);
    props.onUpdateCompileAndRunOptions(
      compileAndRunOptionsBackup.get(newLanguage) || getPreferredCompileAndRunOptions(newLanguage)
    );
  }

  return (
    <>
      <Form.Select
        className={props.classNameForLanguage}
        label={props.headerForLanguage || _(".code_language")}
        aria-label={props.headerForLanguage || _(".code_language")}
        value={props.language}
        options={Object.keys(compileAndRunOptions)
          .filter(language => !props.allowedLanguages || props.allowedLanguages.includes(language as CodeLanguage))
          .map(language => ({
            key: language,
            value: language,
            text: _(`.${language}.name`)
          }))}
        onChange={(e, { value }) => !props.pending && onSwitchLanguage(value as CodeLanguage)}
      />
      {props.elementAfterLanguageSelect}
      {compileAndRunOptions[props.language as CodeLanguage].map(option => {
        switch (option.type) {
          case CodeLanguageOptionType.Select:
            return (
              <Form.Select
                className={props.classNameForCompileAndRunOptions}
                key={option.name}
                label={_(`.${props.language}.options.${option.name}.name`)}
                aria-label={_(`.${props.language}.options.${option.name}.name`)}
                value={props.compileAndRunOptions[option.name] as string}
                options={permittedValues(props.language, option.name, option.values).map(value => ({
                  key: value,
                  value: value,
                  text: _(`.${props.language}.options.${option.name}.values.${value}`)
                }))}
                onChange={(e, { value }) =>
                  !props.pending &&
                  props.onUpdateCompileAndRunOptions(
                    Object.assign({}, props.compileAndRunOptions, { [option.name]: value })
                  )
                }
              />
            );
        }
      })}
    </>
  );
};

CodeLanguageAndOptions = observer(CodeLanguageAndOptions);

export default CodeLanguageAndOptions;
