Two services from train-ticket (github.com/FudanSELab/train-ticket, Apache-2.0,
commit 313886e), copied verbatim, plus the parent POM trimmed to these two modules.
The parent's `<dependencies>` block is what declares `spring-boot-starter-web`;
neither service POM does, which is the shape the Java route gate has to handle.
