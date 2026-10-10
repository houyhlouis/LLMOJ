import fs from "fs-extra";

import { validateSync } from "class-validator";
import { plainToClass } from "class-transformer";
import yaml from "js-yaml";

import { AppConfig, PreferenceConfig } from "./config.schema";
import { checkConfigRelation } from "./config-relation.decorator";

export class ConfigService {
  readonly config: AppConfig;

  readonly preferenceConfigToBeSentToUser: PreferenceConfig;

  constructor() {
    const filePath = process.env.LIBREOJ_CONFIG_FILE;
    if (!filePath) {
      throw new Error("Please specify configuration file with environment variable LIBREOJ_CONFIG_FILE");
    }

    let config: unknown;
    try {
      config = yaml.load(fs.readFileSync(filePath).toString());
    } catch {
      throw new Error("Cannot read or parse backend configuration; private configuration contents withheld.");
    }
    this.config = this.validateInput(config);

    this.preferenceConfigToBeSentToUser = this.getPreferenceConfigToBeSentToUser();
  }

  private validateInput(inputConfig: unknown): AppConfig {
    const appConfig = plainToClass(AppConfig, inputConfig);
    const errors = validateSync(appConfig, {
      validationError: {
        target: false,
        value: false
      }
    });

    if (errors.length > 0) {
      throw new Error(`Config validation error: ${JSON.stringify(errors, null, 2)}`);
    }

    checkConfigRelation(appConfig as unknown as Record<string, unknown>);

    return appConfig;
  }

  private getPreferenceConfigToBeSentToUser(): PreferenceConfig {
    const preference = JSON.parse(JSON.stringify(this.config.preference)) as PreferenceConfig;

    Object.assign(preference.security, {
      registrationMode: this.config.preference.security.registrationMode || "open",
      captchaEnabled: !!(this.config.security.captcha.turnstile || this.config.security.captcha.tencentCaptcha),
      turnstileSiteKey: this.config.security.captcha.turnstile?.siteKey
    });

    // Delete some properties unnessesary to send to user to save bandwidth
    delete preference.serverSideOnly;

    return preference;
  }
}
