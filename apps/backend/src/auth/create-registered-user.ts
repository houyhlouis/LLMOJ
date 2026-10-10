import { EntityManager } from "typeorm";

import { UserAuthEntity } from "./user-auth.entity";

import { UserEntity } from "../user/user.entity";
import { UserInformationEntity } from "../user/user-information.entity";
import { UserPreferenceEntity } from "../user/user-preference.entity";

// The caller owns the transaction: account creation and approval must commit together.
export async function createRegisteredUser(
  manager: EntityManager,
  username: string,
  email: string,
  passwordHash: string,
  publicEmail: boolean
): Promise<UserEntity> {
  const user = manager.create(UserEntity, {
    username,
    email,
    publicEmail,
    nickname: "",
    bio: "",
    avatarInfo: "gravatar:",
    isAdmin: false,
    submissionCount: 0,
    acceptedProblemCount: 0,
    rating: 0,
    registrationTime: new Date()
  });
  await manager.save(user);
  await manager.save(UserAuthEntity, { userId: user.id, password: passwordHash });
  await manager.save(UserInformationEntity, {
    userId: user.id,
    organization: "",
    location: "",
    url: "",
    telegram: "",
    qq: "",
    github: ""
  });
  await manager.save(UserPreferenceEntity, { userId: user.id, preference: {} });
  return user;
}
