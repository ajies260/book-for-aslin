ALTER TABLE `User` DROP CONSTRAINT `User_accountSlot_range`;
ALTER TABLE `User` ADD CONSTRAINT `User_accountSlot_range` CHECK (`accountSlot` BETWEEN 1 AND 7);
