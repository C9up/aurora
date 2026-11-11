/**
 * Node predicates by `nodeType`, so the renderers narrow a `Node` instead of
 * asserting what it is.
 *
 * `nodeType` rather than `instanceof`: a node from another realm (an iframe's
 * document) is not an instance of this realm's `Element`, and the number is
 * what the DOM itself goes by.
 */

/** An element. */
export function isElementNode(node: Node): node is Element {
	return node.nodeType === 1;
}

/** A text node. */
export function isTextNode(node: Node): node is Text {
	return node.nodeType === 3;
}

/** A comment — what aurora anchors its slots with. */
export function isCommentNode(node: Node): node is Comment {
	return node.nodeType === 8;
}

/**
 * A node that can sit in a parent's child list: element, text, CDATA,
 * processing instruction, comment, doctype. Not a document or a fragment.
 */
export function isChildNode(node: Node): node is ChildNode {
	const type = node.nodeType;
	return (
		type === 1 ||
		type === 3 ||
		type === 4 ||
		type === 7 ||
		type === 8 ||
		type === 10
	);
}

/** A document fragment — what cloning a template's content gives back. */
export function isFragmentNode(node: Node): node is DocumentFragment {
	return node.nodeType === 11;
}
