ALTER TABLE `Book` ADD COLUMN `categories` TEXT NULL;
UPDATE `Book` SET `categories` = '[]' WHERE `categories` IS NULL;
ALTER TABLE `Book` MODIFY `categories` TEXT NOT NULL;
