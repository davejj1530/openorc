/** Discussion settings ride with the sealed revision; older revisions keep NULL and read as the defaults. */
export const teamDiscussionMigration = `
ALTER TABLE orchestration_team_revisions ADD COLUMN discussion TEXT CHECK(discussion IS NULL OR json_valid(discussion));
`;
