/**
 * @template {{}} T
 * @typedef {WeakMap<T, T>} CloneMap
 */

class ParserChunk {
  /**
   * @param node {Node}
   * @param parent {Node | null}
   * @param nextSibling {Node | null}
   */
  constructor(node, parent, nextSibling) {
    this.node = node;
    this.parent = parent;
    this.nextSibling = nextSibling;
  }
}

/**
 * @extends {TransformStream<string, ParserChunk>}
 */
export class DOMParserStream extends TransformStream {
  constructor() {
    /** @type {CloneMap<Node>} */
    const cloneMap = new WeakMap();
    /** @type {Set<Node>} */
    const removedNodes = new Set();
    /** @type {Parameters<typeof flushNode> | undefined} */
    let bufferedEntry;
    const doc = document.implementation.createHTMLDocument();
    const cloneStartPoint = document.createElement('template').content;
    doc.write('<template>');

    const root = /** @type {HTMLTemplateElement} */ (doc.querySelector('template')).content;

    /** @type {TransformStreamDefaultController<ParserChunk>} */
    let controller;

    /**
     * @param {Node} node
     * @param {Node | null} parent
     * @param {Node | null} nextSibling
     */
    function flushNode(node, parent, nextSibling) {
      if (!cloneMap.has(node)) {
        const clone = node.cloneNode();
        cloneStartPoint.append(clone);
        cloneMap.set(node, clone);
      }

      controller.enqueue(
        new ParserChunk(
          /** @type {Node} */ (cloneMap.get(node)),
          !parent || parent === root ? null : /** @type {Node} */ (cloneMap.get(parent)),
          !nextSibling ? null : /** @type {Node} */ (cloneMap.get(nextSibling))
        )
      );

      // If this node has reappeared after an earlier removal, remove it from the set.
      const removedNodeFromSet = removedNodes.delete(node);

      // Otherwise, we check to see if one of the removed nodes has reappeared in this one (due to a
      // parsing error)
      if (!removedNodeFromSet) {
        for (const removedNode of removedNodes) {
          if (removedNode.parentNode === node) {
            handleAddedNode(removedNode, removedNode.parentNode, removedNode.nextSibling);
            // Exit. The recursive call will take care of removing this item, and rechecking the set.
            return;
          }
        }
      }
    }

    /**
     * @param {Node} node
     * @param {Node | null} parent
     * @param {Node | null} nextSibling
     */
    function handleAddedNode(node, parent, nextSibling) {
      // Text nodes are buffered until the next node comes along. This means we know the text is
      // complete by the time we yield it, and we don't need to add more text to it.
      if (bufferedEntry) {
        flushNode(...bufferedEntry);
        bufferedEntry = undefined;
      }
      if (node.nodeType === 3) {
        bufferedEntry = [node, parent, nextSibling];
        return;
      }
      flushNode(node, parent, nextSibling);
    }

    new MutationObserver((entries) => {
      for (const entry of entries) {
        // console.log('node', entry.addedNodes[0], 'parent', entry.target, 'removed', entry.removedNodes[0], 'nextSib', entry.nextSibling);
        for (const node of entry.removedNodes) {
          // Nodes are removed during parse errors, but will reappear later. They may be inserted
          // into a node that isn't currently in the document, so it won't reappear in addedNodes,
          // so we need to cater for that.
          removedNodes.add(node);
        }
        for (const node of entry.addedNodes) {
          handleAddedNode(node, entry.target, entry.nextSibling);
        }
      }
    }).observe(root, {
      subtree: true,
      childList: true,
    });

    super({
      start(c) { controller = c; },
      transform(chunk) { doc.write(chunk); },
      flush() {
        if (bufferedEntry) flushNode(...bufferedEntry);
        doc.close();
      }
    });
  }
}

/**
 * @extends {WritableStream<ParserChunk>}
 */
export class DOMWritable extends WritableStream {
  /**
   * @param {Element} target
   */
  constructor(target) {
    super({
      write({ node, nextSibling, parent }) {
        (parent || target).insertBefore(node, nextSibling);
      }
    });
  }
}
