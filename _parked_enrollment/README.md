# Parked: enrollment system (not part of the attendance app)

These files were added in commit 593e8ad but import modules that are not in this repo
(`@/db`, `@/lib/session`, `@/lib/audit`, `@/lib/courses`, `@/lib/enrollment`, ...), so they
broke `next build`. They are kept here, outside `src/`, so nothing is lost. The build and
type checks ignore this folder. Move them back into `src/` only together with the missing files.
