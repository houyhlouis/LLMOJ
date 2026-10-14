-- Add a separate solution category without changing discussion IDs or replies.
-- Existing discussions remain ordinary discussions until their author or a
-- moderator explicitly classifies them. No title-based migration is performed.
ALTER TABLE `discussion`
  ADD COLUMN IF NOT EXISTS `type` varchar(20) NOT NULL DEFAULT 'Discussion';
CREATE INDEX IF NOT EXISTS `IDX_discussion_type` ON `discussion` (`type`);

-- AI job checkpoints explicitly record their generated solutions. Only these
-- verified associations are migrated; handwritten discussions are untouched.
UPDATE `discussion` AS d
INNER JOIN `ai_job` AS j
  ON d.`problemId` = j.`problemId` AND d.`publisherId` = j.`ownerId`
  AND d.`id` IN (
    CAST(JSON_UNQUOTE(JSON_EXTRACT(j.`state`, '$.discussionIds.zh_CN')) AS UNSIGNED),
    CAST(JSON_UNQUOTE(JSON_EXTRACT(j.`state`, '$.discussionIds.en_US')) AS UNSIGNED),
    CAST(JSON_UNQUOTE(JSON_EXTRACT(j.`state`, '$.discussionId')) AS UNSIGNED)
  )
SET d.`type` = 'Solution'
WHERE d.`problemId` IS NOT NULL AND d.`type` = 'Discussion';
