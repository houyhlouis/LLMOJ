// Classification uses recorded AI job IDs and verifies their author and problem.
// It does not infer content categories from titles.
const verifiedAssociation = `
  d.problemId = j.problemId AND d.publisherId = j.ownerId
  AND d.id IN (
    CAST(JSON_UNQUOTE(JSON_EXTRACT(j.state, '$.discussionIds.zh_CN')) AS UNSIGNED),
    CAST(JSON_UNQUOTE(JSON_EXTRACT(j.state, '$.discussionIds.en_US')) AS UNSIGNED),
    CAST(JSON_UNQUOTE(JSON_EXTRACT(j.state, '$.discussionId')) AS UNSIGNED)
  )
`;

export async function inspectVerifiedSolutions(ds) {
  const [column] = await ds.query(`
    SELECT COUNT(*) AS present FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'discussion' AND COLUMN_NAME = 'type'
  `);
  if (!Number(column.present)) return { pending: 0, schemaPending: true };
  const [row] = await ds.query(`
    SELECT COUNT(DISTINCT d.id) AS pending
    FROM discussion d INNER JOIN ai_job j ON ${verifiedAssociation}
    WHERE d.problemId IS NOT NULL AND d.type = 'Discussion'
  `);
  return { pending: Number(row.pending), schemaPending: false };
}

export async function migrateVerifiedSolutions(ds) {
  const before = await inspectVerifiedSolutions(ds);
  if (before.schemaPending) throw new Error("Create discussion.type before migrating verified solutions.");
  await ds.query(`
    UPDATE discussion d INNER JOIN ai_job j ON ${verifiedAssociation}
    SET d.type = 'Solution'
    WHERE d.problemId IS NOT NULL AND d.type = 'Discussion'
  `);
  const after = await inspectVerifiedSolutions(ds);
  return { before: before.pending, after: after.pending, classified: before.pending - after.pending };
}
