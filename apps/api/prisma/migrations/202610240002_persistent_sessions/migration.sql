CREATE TABLE `Session` (
  `sid` VARCHAR(191) NOT NULL,
  `data` LONGTEXT NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  INDEX `Session_expiresAt_idx` (`expiresAt`),
  PRIMARY KEY (`sid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
