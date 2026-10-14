-- Team schema. Prefer the validated offline upgrade.py workflow for existing installations.

CREATE TABLE IF NOT EXISTS `team` (`id` int NOT NULL AUTO_INCREMENT, `name` varchar(80) NOT NULL, `description` mediumtext NOT NULL, `announcement` mediumtext NOT NULL, `ownerId` int NOT NULL, `permissionGroupId` int NOT NULL, `joinPolicy` varchar(16) NOT NULL DEFAULT 'approval', `groupChangeLocked` tinyint NOT NULL DEFAULT 0, `archived` tinyint NOT NULL DEFAULT 0, `memberCount` int NOT NULL DEFAULT '0', `quotaLimit` bigint NOT NULL DEFAULT '10737418240', `quotaUsed` bigint NOT NULL DEFAULT '0', `createdAt` datetime NOT NULL, UNIQUE INDEX `IDX_cf461f5b40cf1a2b8876011e1e` (`name`), INDEX `IDX_49a22109d0b97611c07768e37f` (`ownerId`), UNIQUE INDEX `IDX_f8d9a753097a283e7e56bc80b6` (`permissionGroupId`), INDEX `IDX_0daa7e1ac2e097f1f8e2bc6156` (`archived`), PRIMARY KEY (`id`)) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `team_member` (`id` int NOT NULL AUTO_INCREMENT, `teamId` int NOT NULL, `userId` int NOT NULL, `status` varchar(16) NOT NULL, `groupId` int NULL, `note` varchar(2000) NOT NULL DEFAULT '', `application` varchar(2000) NOT NULL DEFAULT '', `permissions` longtext NOT NULL, `joinedAt` datetime NOT NULL, INDEX `IDX_74da8f612921485e1005dc8e22` (`teamId`), INDEX `IDX_d2be3e8fc9ab0f69673721c7fc` (`userId`), UNIQUE INDEX `IDX_bd2b3ef7569d75642e09185377` (`teamId`, `userId`), PRIMARY KEY (`id`)) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `team_member_group` (`id` int NOT NULL AUTO_INCREMENT, `teamId` int NOT NULL, `name` varchar(80) NOT NULL, `archived` tinyint NOT NULL DEFAULT 0, INDEX `IDX_f78d031dfd6e5934f78588f7a3` (`teamId`), UNIQUE INDEX `IDX_caa522d7f6e238ebec65b4bceb` (`teamId`, `name`), PRIMARY KEY (`id`)) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `team_resource` (`id` int NOT NULL AUTO_INCREMENT, `teamId` int NOT NULL, `kind` varchar(16) NOT NULL, `resourceId` int NOT NULL, `visibility` varchar(16) NOT NULL DEFAULT 'private', `invitedUserIds` longtext NOT NULL, `inviteCode` char(36) NULL, `archived` tinyint NOT NULL DEFAULT 0, INDEX `IDX_9c66a39174c8c5c78eb0810b86` (`teamId`), UNIQUE INDEX `IDX_420b9000fd2e9b5b78b0aadbce` (`inviteCode`), UNIQUE INDEX `IDX_cedcb1ae416bbe1c3bbfee3c54` (`kind`, `resourceId`), PRIMARY KEY (`id`)) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `team_invitation` (`id` int NOT NULL AUTO_INCREMENT, `teamId` int NOT NULL, `token` char(36) NOT NULL, `userId` int NULL, `maxUses` int NOT NULL DEFAULT '1', `uses` int NOT NULL DEFAULT '0', `expiresAt` datetime NOT NULL, `active` tinyint NOT NULL DEFAULT 1, INDEX `IDX_f3d2441efc544a7cc085bdb670` (`teamId`), UNIQUE INDEX `IDX_d127bc67021ecca92d4a4be529` (`token`), PRIMARY KEY (`id`)) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `team_assignment` (`id` int NOT NULL AUTO_INCREMENT, `teamId` int NOT NULL, `title` varchar(160) NOT NULL, `description` mediumtext NOT NULL, `items` longtext NOT NULL, `deadline` datetime NULL, `assignedUserIds` longtext NOT NULL, `assignedGroupIds` longtext NOT NULL, `archived` tinyint NOT NULL DEFAULT 0, `createdAt` datetime NOT NULL, INDEX `IDX_4ef3daff307d1654d79a8e918c` (`teamId`), PRIMARY KEY (`id`)) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `team_file` (`id` int NOT NULL AUTO_INCREMENT, `teamId` int NOT NULL, `name` varchar(240) NOT NULL, `uuid` char(36) NOT NULL, `size` bigint NOT NULL, `uploaderId` int NOT NULL, `archived` tinyint NOT NULL DEFAULT 0, `createdAt` datetime NOT NULL, INDEX `IDX_7715685076fa6bd7ad23e7d9ed` (`teamId`), UNIQUE INDEX `IDX_275ef7fdb882dbf67745c0f0cd` (`uuid`), PRIMARY KEY (`id`)) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `team_file_upload` (`uuid` char(36) NOT NULL, `teamId` int NOT NULL, `userId` int NOT NULL, `size` bigint NOT NULL, `parts` longtext NOT NULL, `expiresAt` datetime NOT NULL, INDEX `IDX_728d96acee6f8249aeba91c5f2` (`teamId`), PRIMARY KEY (`uuid`)) ENGINE=InnoDB;

-- Supported older team installations: widen metadata without dropping existing values.

ALTER TABLE `file` CHANGE `size` `size` bigint NOT NULL;

ALTER TABLE `team_file` CHANGE `size` `size` bigint NOT NULL;

ALTER TABLE `team` CHANGE `quotaLimit` `quotaLimit` bigint NOT NULL DEFAULT '10737418240';

UPDATE `team` SET `quotaLimit` = 10737418240 WHERE `quotaLimit` <> 10737418240;
