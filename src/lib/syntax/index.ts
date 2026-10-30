export { parseSource } from './parser';
export { Scanner, getLeadingCommentRanges, getTrailingCommentRanges, hasCommentTrivia } from './scanner';
export { TextNode, isImportDeclaration, isNamespaceImport, isNamedImports, resolveReference } from './model';
export type {
	SourceFile, ImportDeclaration, ImportClause, ImportSpecifier, NamedImports, NamespaceImport,
	CommentRange, Scope, Binding, Reference, ExportEntry, FunctionInfo,
} from './model';
