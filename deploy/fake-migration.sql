-- Repeatable MariaDB/MySQL migration; select the OJ database before executing this file.
-- Existing enum positions, submissions and original judge results remain unchanged.
-- Take a backup and stop the backend before applying this incremental deployment migration.
-- Unknown enum definitions/defaults/nullability abort for manual review.
DROP PROCEDURE IF EXISTS llmoj_migrate_fake_verdict_20261013;
DELIMITER //
CREATE PROCEDURE llmoj_migrate_fake_verdict_20261013()
BEGIN
  DECLARE current_type LONGTEXT DEFAULT NULL;
  DECLARE current_nullable VARCHAR(3);
  DECLARE current_default LONGTEXT;
  DECLARE current_extra LONGTEXT;
  DECLARE old_type LONGTEXT DEFAULT 'enum(''Pending'',''ConfigurationError'',''SystemError'',''Canceled'',''CompilationError'',''FileError'',''RuntimeError'',''TimeLimitExceeded'',''MemoryLimitExceeded'',''OutputLimitExceeded'',''PartiallyCorrect'',''WrongAnswer'',''Accepted'',''JudgementFailed'')';
  DECLARE new_type LONGTEXT DEFAULT 'enum(''Pending'',''ConfigurationError'',''SystemError'',''Canceled'',''CompilationError'',''FileError'',''RuntimeError'',''TimeLimitExceeded'',''MemoryLimitExceeded'',''OutputLimitExceeded'',''PartiallyCorrect'',''WrongAnswer'',''Accepted'',''JudgementFailed'',''Fake'')';
  DECLARE hack_type LONGTEXT DEFAULT 'enum(''Pending'',''ConfigurationError'',''SystemError'',''Canceled'',''CompilationError'',''FileError'',''RuntimeError'',''TimeLimitExceeded'',''MemoryLimitExceeded'',''OutputLimitExceeded'',''PartiallyCorrect'',''WrongAnswer'',''Accepted'',''JudgementFailed'',''Fake'',''Hacked'')';
  SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA INTO current_type, current_nullable, current_default, current_extra
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'submission' AND COLUMN_NAME = 'status';
  IF current_type IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Missing submission.status in the selected database; Fake migration aborted';
  END IF;
  IF current_nullable <> 'NO' OR current_default IS NOT NULL OR current_extra <> '' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Unexpected submission.status attributes; inspect SHOW CREATE TABLE before migrating';
  END IF;
  IF BINARY current_type = BINARY old_type THEN
    ALTER TABLE submission MODIFY COLUMN status ENUM(
      'Pending', 'ConfigurationError', 'SystemError', 'Canceled', 'CompilationError', 'FileError',
      'RuntimeError', 'TimeLimitExceeded', 'MemoryLimitExceeded', 'OutputLimitExceeded', 'PartiallyCorrect',
      'WrongAnswer', 'Accepted', 'JudgementFailed', 'Fake'
    ) NOT NULL;
  ELSEIF BINARY current_type <> BINARY new_type AND BINARY current_type <> BINARY hack_type THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Unexpected submission.status enum or order; Fake migration aborted';
  END IF;
END//
DELIMITER ;
CALL llmoj_migrate_fake_verdict_20261013();
DROP PROCEDURE llmoj_migrate_fake_verdict_20261013;
