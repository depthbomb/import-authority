export type CommentRange = { pos: number; end: number; block: boolean };
// Type, value, or both namespaces. Type aliases can coexist with value bindings.
export type Meaning = 1 | 2 | 3;
export type Scope = {
	parent?:  Scope;
	kind:     'module' | 'function' | 'block' | 'type' | 'static' | 'namespace';
	bindings: Map<string, Binding[]>;
	namespaces?: Map<string, Scope>;
	namespace?: Scope;
	exports?: ExportEntry[];
	exportEquals?: boolean;
	ambient?: boolean;
};
export type Binding = {
	name:      string;
	start:     number;
	scope:     Scope;
	meaning:   Meaning;
	constant:  boolean;
	function?: FunctionInfo;
	import?:   { module: string; imported: string };
	alias?:    { reference: Reference; members: string[] };
	namespace?: Scope;
};
export type FunctionInfo = {
	start:     number;
	end:       number;
	body:      boolean;
	dependent: boolean;
};
export type MemberAccess = {
	name:      string;
	nameStart: number;
	start:     number;
	end:       number;
	optional:  boolean;
	call:      boolean;
	jsx:       boolean;
	computed:  boolean;
};
export type Reference = {
	name:     string;
	start:    number;
	end:      number;
	scope:    Scope;
	typeOnly: boolean;
	meaning:  Meaning;
	written:  boolean;
	member?:  MemberAccess;
};
export type ExportEntry = {
	exported:   string;
	binding?:   Binding;
	commonJs?:  Reference;
	local?:     string;
	module?:    string;
	imported?:  string;
	namespace?: boolean;
	scope?: Scope;
	source?: SourceFile;
};
export type ImportSpecifier = {
	name:          TextNode;
	propertyName?: TextNode;
	isTypeOnly:    boolean;
};
export type NamedImports = TextNode & { kind: 'named'; elements: ImportSpecifier[] };
export type NamespaceImport = TextNode & { kind: 'namespace'; name: TextNode };
export type ImportClause = {
	name?:          TextNode;
	namedBindings?: NamedImports | NamespaceImport;
	isTypeOnly:     boolean;
	phaseModifier?: string;
};
export type ImportDeclaration = TextNode & {
	kind:            'import';
	moduleSpecifier: TextNode;
	importClause?:   ImportClause;
	attributes?:     TextNode;
};
export type SourceFile = {
	fileName:            string;
	text:                string;
	statements:          TextNode[];
	endOfFileToken:      TextNode;
	comments:            CommentRange[];
	jsdocComments:       Set<number>;
	parseDiagnostics:    string[];
	scope:               Scope;
	references:          Reference[];
	identifierPositions: Map<number, string>;
	exports:             ExportEntry[];
	ambientModules:      Map<string, Scope>;
	exportEquals:        boolean;
	hasJsx:              boolean;
	hasDecorators:       boolean;
	hasEval:             boolean;
};

export class TextNode {
	public parent!: SourceFile;
	public kind = 'statement';

	public constructor(
		private readonly content: string,
		public readonly start: number,
		public readonly end: number,
		public readonly pos = start,
		public readonly text = content.slice(start, end),
	) {}

	public getStart(_source?: SourceFile): number {
		return this.start;
	}

	public getFullStart(): number {
		return this.pos;
	}

	public getEnd(): number {
		return this.end;
	}

	public getText(_source?: SourceFile): string {
		return this.content.slice(this.start, this.end);
	}
}

export function isImportDeclaration(node: TextNode): node is ImportDeclaration {
	return node.kind === 'import';
}

export function isNamespaceImport(node: NamedImports | NamespaceImport): node is NamespaceImport {
	return node.kind === 'namespace';
}

export function isNamedImports(node: NamedImports | NamespaceImport): node is NamedImports {
	return node.kind === 'named';
}

export function resolveReference(reference: Reference): Binding | undefined {
	for (let scope: Scope | undefined = reference.scope; scope; scope = scope.parent) {
		const binding = scope.bindings.get(reference.name)?.find(candidate => candidate.meaning & reference.meaning);
		if (binding) {
			return binding;
		}
	}

	return undefined;
}
