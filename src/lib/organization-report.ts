import type { OrganizationReason, OrganizationReport } from './organizer';

const explanations: Record<OrganizationReason, string> = {
	'syntax-error': 'Syntax errors prevented organization in the affected source block.',
	'ignored-file': 'File skipped by import-authority-ignore-file.',
	'protected-imports': 'Ignored, pinned, or disabled imports were preserved.',
	'no-imports': 'No import declarations found.',
	'no-supported-scripts': 'No supported inline Vue script blocks found.',
	'unsupported-scripts': 'External or unsupported Vue script blocks were skipped.',
	'malformed-vue': 'Malformed Vue markup prevented organization.',
};

export function describeOrganization(report: OrganizationReport, changed: boolean, removed: number, notes: string[]): string {
	const outcome = changed ? 'Imports organized.' : report.reasons.length > 0 ? 'No changes.' : 'Imports are already organized.';
	const counts = `${describeOrganizationCounts(report, removed)}.`;
	return [outcome, counts, ...report.reasons.map(reason => explanations[reason]), ...report.conversionNotes, ...notes].join(' ');
}

export function describeOrganizationCounts(report: OrganizationReport, removed: number): string {
	return `${report.merged} merged, ${report.moved} moved, ${removed} binding${removed === 1 ? '' : 's'} removed`
		+ (report.converted > 0 ? `, ${report.converted} converted to type imports` : '');
}
