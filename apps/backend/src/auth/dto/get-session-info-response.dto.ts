import { ApiProperty } from "@nestjs/swagger";

import { UserPrivilegeType } from "../../user/user-privilege.service";

import { PreferenceConfig } from "../../config/config.schema";

import { UserMetaDto, UserPreferenceDto } from "../../user/dto";

export class ServerVersionDto {
  @ApiProperty()
  hash: string;

  @ApiProperty()
  date: string;
}

export class GetSessionInfoResponseDto {
  @ApiProperty()
  userMeta?: UserMetaDto;

  @ApiProperty()
  joinedGroupsCount?: number;

  @ApiProperty({ enum: UserPrivilegeType, isArray: true })
  userPrivileges?: UserPrivilegeType[];

  @ApiProperty()
  userPreference?: UserPreferenceDto;

  @ApiProperty()
  serverPreference: PreferenceConfig;

  @ApiProperty()
  serverVersion: ServerVersionDto;

  // The marker of the session when the session cookie carries it, for the page to keep instead of a token
  @ApiProperty({ required: false })
  sessionMarker?: string;
}
