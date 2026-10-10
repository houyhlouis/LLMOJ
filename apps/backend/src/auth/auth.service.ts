import { Injectable, Inject, forwardRef } from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";

import { Repository, DataSource, EntityManager } from "typeorm";
import * as bcrypt from "bcrypt";

import { RegistrationReviewStatus } from "./registration-review.entity";
import { RegistrationApplicationEntity } from "./registration-application.entity";
import { createRegisteredUser } from "./create-registered-user";

import { UserAuthEntity } from "./user-auth.entity";

import { AuthEmailVerificationCodeService } from "./auth-email-verification-code.service";

import { RegisterResponseError } from "./dto";

import { UserEntity } from "../user/user.entity";
import { UserService } from "../user/user.service";
import { ConfigService } from "../config/config.service";
import { delay, DELAY_FOR_SECURITY } from "../common/delay";

@Injectable()
export class AuthService {
  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    @InjectRepository(UserAuthEntity)
    private readonly userAuthRepository: Repository<UserAuthEntity>,
    @Inject(forwardRef(() => UserService))
    private readonly userService: UserService,
    @Inject(forwardRef(() => AuthEmailVerificationCodeService))
    private readonly authEmailVerificationCodeService: AuthEmailVerificationCodeService,
    @Inject(forwardRef(() => ConfigService))
    private readonly configService: ConfigService
  ) {}

  private async hashPassword(password: string): Promise<string> {
    return await bcrypt.hash(password, 10);
  }

  async findUserAuthByUserId(userId: number): Promise<UserAuthEntity> {
    return await this.userAuthRepository.findOneBy({
      userId
    });
  }

  async register(
    username: string,
    email: string,
    emailVerificationCode: string,
    password: string
  ): Promise<[error: RegisterResponseError, user: UserEntity]> {
    const registrationMode = this.configService.config.preference.security.registrationMode || "open";
    if (registrationMode === "closed") return [RegisterResponseError.REGISTRATION_CLOSED, null];

    // There's a race condition on user inserting. If we do checking before inserting,
    // inserting will still fail if another with same username is inserted after we check

    if (this.configService.config.preference.security.requireEmailVerification) {
      // Delay for security
      await delay(DELAY_FOR_SECURITY);
      if (!(await this.authEmailVerificationCodeService.verify(email, emailVerificationCode)))
        return [RegisterResponseError.INVALID_EMAIL_VERIFICATION_CODE, null];
    }

    if (!(await this.userService.checkUsernameAvailability(username)))
      return [RegisterResponseError.DUPLICATE_USERNAME, null];
    if (!(await this.userService.checkEmailAvailability(email))) return [RegisterResponseError.DUPLICATE_EMAIL, null];
    const passwordHash = await this.hashPassword(password);
    try {
      let user: UserEntity = null;
      await this.connection.transaction("READ COMMITTED", async manager => {
        if (registrationMode === "approval") {
          // No user row or user-ID allocation occurs before administrative approval.
          await manager.save(RegistrationApplicationEntity, {
            username,
            email,
            reservedUsername: username,
            reservedEmail: email,
            passwordHash,
            status: RegistrationReviewStatus.Pending,
            createdAt: new Date(),
            userId: null
          });
        } else {
          user = await createRegisteredUser(manager, username, email, passwordHash, true);
        }
      });

      if (this.configService.config.preference.security.requireEmailVerification) {
        await this.authEmailVerificationCodeService.revoke(email, emailVerificationCode);
      }

      return [null, user];
    } catch (e) {
      if (!(await this.userService.checkUsernameAvailability(username)))
        return [RegisterResponseError.DUPLICATE_USERNAME, null];

      if (!(await this.userService.checkEmailAvailability(email))) return [RegisterResponseError.DUPLICATE_EMAIL, null];

      // Unknown error
      // (or the duplicate user's username is just changed?)
      throw e;
    }
  }

  async checkPassword(userAuth: UserAuthEntity, password: string): Promise<boolean> {
    return await bcrypt.compare(password, userAuth.password);
  }

  checkUserMigrated(userAuth: UserAuthEntity): boolean {
    return userAuth.password != null;
  }

  async changePassword(
    userAuth: UserAuthEntity,
    password: string,
    transactionalEntityManager?: EntityManager
  ): Promise<void> {
    userAuth.password = await this.hashPassword(password);
    if (transactionalEntityManager) await transactionalEntityManager.save(userAuth);
    else await this.userAuthRepository.save(userAuth);
  }
}
