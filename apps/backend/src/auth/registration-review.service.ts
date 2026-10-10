import { BadRequestException, ForbiddenException, Injectable, OnModuleInit, Inject, forwardRef } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, EntityManager } from "typeorm";
import * as bcrypt from "bcrypt";

import { RegistrationReviewEntity, RegistrationReviewStatus } from "./registration-review.entity";
import { RegistrationApplicationEntity } from "./registration-application.entity";
import { createRegisteredUser } from "./create-registered-user";
import {
  ListRegistrationReviewsRequestDto,
  ListRegistrationReviewsResponseDto,
  RegistrationReviewDto,
  RegistrationReviewResponseError,
  ReviewRegistrationRequestDto,
  ReviewRegistrationResponseDto
} from "./dto/registration-review.dto";

import { UserEntity } from "../user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";
import { AuditLogEntity, AuditLogObjectType } from "../audit/audit-log.entity";

@Injectable()
export class RegistrationReviewService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly connection: DataSource,
    @Inject(forwardRef(() => UserPrivilegeService)) private readonly privileges: UserPrivilegeService
  ) {}

  private async reviewer(actor: UserEntity, manager: EntityManager): Promise<UserEntity | null> {
    // Permission writers lock this same user before changing grants/overrides.
    // This also protects an absent override row when a legacy grant is revoked.
    const current = await manager.findOne(UserEntity, {
      where: { id: actor.id },
      lock: { mode: "pessimistic_read" }
    });
    return current &&
      (await this.privileges.userHasPrivilege(current, UserPrivilegeType.ViewSite, manager)) &&
      (await this.privileges.userHasPrivilege(current, UserPrivilegeType.ManageRegistrationReviews, manager))
      ? current
      : null;
  }

  async onModuleInit(): Promise<void> {
    // Never silently expose or delete users created by the earlier approval design.
    // The supported upgrader first verifies and migrates empty legacy shells.
    if (
      await this.connection.manager.countBy(RegistrationReviewEntity, [
        { status: RegistrationReviewStatus.Pending },
        { status: RegistrationReviewStatus.Rejected }
      ])
    )
      throw new Error(
        "Unmigrated legacy registration reviews: run the supported registration-application upgrade before starting the backend; existing users have not been deleted."
      );
  }

  async status(user: UserEntity, manager: EntityManager = this.connection.manager): Promise<RegistrationReviewStatus> {
    if (user.isAdmin) return RegistrationReviewStatus.Approved;
    return (
      (await manager.findOneBy(RegistrationReviewEntity, { userId: user.id }))?.status ||
      RegistrationReviewStatus.Approved
    );
  }

  async requireApproved(user: UserEntity): Promise<void> {
    if (!user) throw new ForbiddenException({ error: "PERMISSION_DENIED" });
    const status = await this.status(user);
    if (status !== RegistrationReviewStatus.Approved)
      throw new ForbiddenException({
        error: status === RegistrationReviewStatus.Pending ? "REGISTRATION_PENDING" : "REGISTRATION_REJECTED"
      });
  }

  async applicationStatusByEmail(email: string): Promise<RegistrationReviewStatus | null> {
    return (
      (await this.connection.manager.findOneBy(RegistrationApplicationEntity, { reservedEmail: email }))?.status || null
    );
  }

  async checkApplicationPassword(
    username: string,
    email: string,
    password: string
  ): Promise<RegistrationReviewStatus | null> {
    const query = this.connection
      .getRepository(RegistrationApplicationEntity)
      .createQueryBuilder("application")
      .addSelect("application.passwordHash");
    if (username) query.where("application.reservedUsername = :username", { username });
    else query.where("application.reservedEmail = :email", { email });
    const application = await query.getOne();
    if (!application?.passwordHash || !(await bcrypt.compare(password, application.passwordHash))) return null;
    return application.status;
  }

  private dto(application: RegistrationApplicationEntity): RegistrationReviewDto {
    return {
      applicationId: application.id,
      userId: application.status === RegistrationReviewStatus.Approved ? application.userId : null,
      username: application.username,
      email: application.email,
      registrationTime: application.createdAt,
      status: application.status,
      reviewedAt: application.reviewedAt,
      reviewedBy: application.reviewedBy,
      reason: application.reason
    };
  }

  async list(
    actor: UserEntity,
    request: ListRegistrationReviewsRequestDto
  ): Promise<ListRegistrationReviewsResponseDto> {
    if (!actor) return { error: RegistrationReviewResponseError.PERMISSION_DENIED };
    const skip = request.skipCount ?? 0;
    const take = request.takeCount ?? 20;
    if (!Number.isInteger(skip) || skip < 0 || skip > 1000000 || !Number.isInteger(take) || take < 1 || take > 100)
      throw new BadRequestException("Invalid registration review pagination");
    if (request.status != null && !Object.values(RegistrationReviewStatus).includes(request.status))
      throw new BadRequestException("Invalid registration review status");
    return await this.connection.transaction("READ COMMITTED", async manager => {
      if (!(await this.reviewer(actor, manager))) return { error: RegistrationReviewResponseError.PERMISSION_DENIED };
      const [applications, count] = await manager.getRepository(RegistrationApplicationEntity).findAndCount({
        where: request.status == null ? {} : { status: request.status },
        order: { createdAt: "DESC", id: "DESC" },
        skip,
        take
      });
      return { reviews: applications.map(application => this.dto(application)), count };
    });
  }

  async review(
    actor: UserEntity,
    request: ReviewRegistrationRequestDto,
    ip: string
  ): Promise<ReviewRegistrationResponseDto> {
    if (!actor) return { error: RegistrationReviewResponseError.PERMISSION_DENIED };
    if (
      ![RegistrationReviewStatus.Approved, RegistrationReviewStatus.Rejected].includes(request.decision) ||
      !Number.isInteger(request.applicationId) ||
      request.applicationId < 1 ||
      (request.reason != null && (typeof request.reason !== "string" || request.reason.length > 500))
    )
      throw new BadRequestException("Invalid registration review decision");
    try {
      return await this.connection.transaction("READ COMMITTED", async manager => {
        const reviewer = await this.reviewer(actor, manager);
        if (!reviewer) return { error: RegistrationReviewResponseError.PERMISSION_DENIED };
        const application = await manager
          .getRepository(RegistrationApplicationEntity)
          .createQueryBuilder("application")
          .addSelect("application.passwordHash")
          .where("application.id = :id", { id: request.applicationId })
          .setLock("pessimistic_write")
          .getOne();
        if (!application) return { error: RegistrationReviewResponseError.NO_SUCH_APPLICATION };
        if (application.status === request.decision) return { review: this.dto(application) };
        if (application.status === RegistrationReviewStatus.Approved)
          return { error: RegistrationReviewResponseError.ALREADY_REVIEWED };
        const previousStatus = application.status;
        if (request.decision === RegistrationReviewStatus.Approved) {
          if (await manager.countBy(UserEntity, { username: application.username }))
            return { error: RegistrationReviewResponseError.DUPLICATE_USERNAME };
          if (await manager.countBy(UserEntity, { email: application.email }))
            return { error: RegistrationReviewResponseError.DUPLICATE_EMAIL };
          if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(application.passwordHash || ""))
            throw new BadRequestException("Registration application has no valid password hash");
          const user = await createRegisteredUser(
            manager,
            application.username,
            application.email,
            application.passwordHash,
            false
          );
          application.userId = user.id;
          application.passwordHash = null;
          application.reservedUsername = null;
          application.reservedEmail = null;
        }
        application.status = request.decision;
        application.reviewedBy = reviewer.id;
        application.reviewedAt = new Date();
        application.reason = request.reason?.trim() || null;
        await manager.save(application);
        await manager.save(AuditLogEntity, {
          userId: reviewer.id,
          ip: ip || "127.0.0.1",
          time: application.reviewedAt,
          action: `auth.registration_${application.status}`,
          firstObjectType: application.userId ? AuditLogObjectType.User : null,
          firstObjectId: application.userId || null,
          details: {
            applicationId: application.id,
            from: previousStatus,
            to: application.status,
            reason: application.reason
          }
        });
        return { review: this.dto(application) };
      });
    } catch (error) {
      // A profile edit can win the unique-key race after our initial checks.
      if (error?.code === "ER_DUP_ENTRY") {
        const application = await this.connection.manager.findOneBy(RegistrationApplicationEntity, {
          id: request.applicationId
        });
        if (application && (await this.connection.manager.countBy(UserEntity, { username: application.username })))
          return { error: RegistrationReviewResponseError.DUPLICATE_USERNAME };
        if (application && (await this.connection.manager.countBy(UserEntity, { email: application.email })))
          return { error: RegistrationReviewResponseError.DUPLICATE_EMAIL };
      }
      throw error;
    }
  }
}
