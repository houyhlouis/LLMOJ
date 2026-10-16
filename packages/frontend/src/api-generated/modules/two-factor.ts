// This file is generated automatically, do NOT modify it.

/// <reference path="../types.d.ts" />

import { createGetApi, createPostApi } from "@/api";

export const getStatus = createPostApi<ApiTypes.GetTwoFactorStatusRequestDto, ApiTypes.GetTwoFactorStatusResponseDto>(
  "twoFactor/getStatus",
  {}
);
export const beginTotpSetup = createPostApi<void, ApiTypes.BeginTotpSetupResponseDto>("twoFactor/beginTotpSetup", {});
export const confirmTotpSetup = createPostApi<ApiTypes.ConfirmTotpSetupRequestDto, ApiTypes.RecoveryCodesResponseDto>(
  "twoFactor/confirmTotpSetup",
  {}
);
export const disableTotp = createPostApi<void, ApiTypes.TwoFactorActionResponseDto>("twoFactor/disableTotp", {});
export const beginPasskeyRegistration = createPostApi<void, ApiTypes.BeginPasskeyRegistrationResponseDto>(
  "twoFactor/beginPasskeyRegistration",
  {}
);
export const finishPasskeyRegistration = createPostApi<
  ApiTypes.FinishPasskeyRegistrationRequestDto,
  ApiTypes.RecoveryCodesResponseDto
>("twoFactor/finishPasskeyRegistration", {});
export const removePasskey = createPostApi<ApiTypes.RemovePasskeyRequestDto, ApiTypes.TwoFactorActionResponseDto>(
  "twoFactor/removePasskey",
  {}
);
export const regenerateRecoveryCodes = createPostApi<void, ApiTypes.RecoveryCodesResponseDto>(
  "twoFactor/regenerateRecoveryCodes",
  {}
);
export const resetUserTwoFactor = createPostApi<
  ApiTypes.ResetUserTwoFactorRequestDto,
  ApiTypes.TwoFactorActionResponseDto
>("twoFactor/resetUserTwoFactor", {});
export const completeLogin = createPostApi<
  ApiTypes.CompleteTwoFactorLoginRequestDto,
  ApiTypes.CompleteTwoFactorLoginResponseDto
>("twoFactor/completeLogin", {});
export const getReauthenticationOptions = createPostApi<void, ApiTypes.GetReauthenticationOptionsResponseDto>(
  "twoFactor/getReauthenticationOptions",
  {}
);
export const reauthenticate = createPostApi<ApiTypes.ReauthenticateRequestDto, ApiTypes.TwoFactorActionResponseDto>(
  "twoFactor/reauthenticate",
  {}
);
