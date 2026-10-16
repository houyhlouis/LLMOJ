import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { RegistrationApplicationEntity } from "./registration-application.entity";

import { RegistrationReviewEntity } from "./registration-review.entity";
import { RegistrationReviewService } from "./registration-review.service";

import { UserAuthEntity } from "./user-auth.entity";

import { AuthService } from "./auth.service";

import { AuthController } from "./auth.controller";

import { AuthEmailVerificationCodeService } from "./auth-email-verification-code.service";

import { AuthSessionService } from "./auth-session.service";

import { AuthIpLocationService } from "./auth-ip-location.service";

import { UserTwoFactorEntity } from "./two-factor/user-two-factor.entity";
import { UserPasskeyEntity } from "./two-factor/user-passkey.entity";
import { TwoFactorService } from "./two-factor/two-factor.service";
import { TwoFactorController } from "./two-factor/two-factor.controller";

import { UserModule } from "../user/user.module";
import { GroupModule } from "../group/group.module";
import { RedisModule } from "../redis/redis.module";
import { MailModule } from "../mail/mail.module";
import { AuditModule } from "../audit/audit.module";
import { MigrationModule } from "../migration/migration.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserAuthEntity,
      RegistrationReviewEntity,
      RegistrationApplicationEntity,
      UserTwoFactorEntity,
      UserPasskeyEntity
    ]),
    forwardRef(() => UserModule),
    forwardRef(() => GroupModule),
    forwardRef(() => RedisModule),
    forwardRef(() => MailModule),
    forwardRef(() => AuditModule),
    forwardRef(() => MigrationModule)
  ],
  providers: [
    RegistrationReviewService,
    AuthService,
    AuthEmailVerificationCodeService,
    AuthSessionService,
    AuthIpLocationService,
    TwoFactorService
  ],
  controllers: [AuthController, TwoFactorController],
  exports: [
    RegistrationReviewService,
    AuthService,
    AuthEmailVerificationCodeService,
    AuthSessionService,
    AuthIpLocationService,
    TwoFactorService
  ]
})
export class AuthModule {}
