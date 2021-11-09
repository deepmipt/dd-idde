import sys
import dataclasses
import libcst as cst
import libcst.matchers as m

from typing import Literal, Optional, Union, List, Dict, DefaultDict, cast
from dataclasses import dataclass, field
from collections import defaultdict

BaseUpdate = Union["ValueUpdate", "ListUpdate", "DictUpdate"]


@dataclass
class DictUpdate:
    elements: Dict[str, BaseUpdate] = field(default_factory=dict)
    allow_extra: bool = True

    @classmethod
    def from_dict(cls, dicitonary: Union[DefaultDict, Dict]):
        def convert(
            val: Union["DictUpdate", "ValueUpdate", str, Dict, List, DefaultDict]
        ):
            if isinstance(val, ValueUpdate):
                return val
            elif isinstance(val, (ListUpdate, DictUpdate)):
                converted = convert(val.elements)
                return dataclasses.replace(val, elements=converted.elements)
            elif isinstance(val, str):
                return ValueUpdate(val)
            elif isinstance(val, (dict, defaultdict)):
                return DictUpdate({k: convert(v) for k, v in val.items()})
            elif isinstance(val, list):
                return ListUpdate([convert(v) for v in val])
            else:
                raise TypeError(f"Unsupported type: {type(val)}")

        return cast(DictUpdate, convert(dicitonary))

    def get(self, key: str):
        if key in self.elements:
            return key, self.elements[key]
        target_expr = cst.parse_expression(key)
        expr_val = getattr(target_expr, "value", None)
        if expr_val in self.elements:
            return expr_val, self.elements[expr_val]  # type: ignore
        key = getattr(target_expr, "raw_value", key)
        for k, v in self.elements.items():
            expr = cst.parse_expression(k) if k != "" else ""
            if getattr(expr, "value", None) == key:
                return k, v
            if getattr(expr, "raw_value", None) == key:
                return k, v
        return None, None

    def pop(self, key: Union[str, cst.BaseExpression]):
        if isinstance(key, (cst.Name, cst.SimpleString)):
            str_key = key.value
        elif isinstance(key, cst.Tuple):
            str_key = f"({key.elements[0].value}, {key.elements[1].value})"
        elif isinstance(key, cst.Call):
            return None
        elif isinstance(key, str):
            str_key = key
        else:
            raise TypeError(f"Unsupported type {type(key)}")
        str_key, _ = self.get(str_key)
        if str_key is None:
            return None
        return self.elements.pop(str_key, None)

    def __iter__(self):
        for k in list(self.elements.keys()):
            yield k, self.elements.pop(k)


@dataclass
class ListUpdate:
    elements: List[BaseUpdate] = field(default_factory=list)
    allow_extra: bool = True
    order_significant: bool = True

    def pop(self, item: Union[BaseUpdate, cst.BaseExpression]):
        idx = next((i for i, el in enumerate(self.elements) if el == item), None)
        return None if idx is None else self.elements.pop(idx)

    def __iter__(self):
        for i in range(len(self.elements)):
            ret = i, self.elements.pop(i)
            yield ret


@dataclass
class ValueUpdate:
    value: str = ""
    remove: bool = False
    parsed: cst.BaseExpression = field(init=False, repr=False)

    def __post_init__(self):
        self.parsed = cst.parse_expression(self.value)

    def __eq__(self, b: Union[BaseUpdate, cst.BaseExpression]) -> bool:
        if isinstance(b, cst.BaseExpression):
            return b.deep_equals(self.parsed)
        elif isinstance(b, ValueUpdate):
            return self.parsed.deep_equals(b.parsed)
        return NotImplemented


def find_flow(py_tree: cst.Module) -> Optional[cst.Dict]:
    for line in py_tree.body:
        # It's an assign
        if isinstance(line.body, cst.BaseSuite) or not isinstance(
            line.body[0], cst.Assign
        ):
            continue
        assign = line.body[0]
        # The value is a dict
        if not isinstance(assign.value, cst.Dict):
            continue
        root_dict = assign.value
        # All values of this dict are all dicts (the flows)
        root_all_dicts = all(
            isinstance(el.value, cst.Dict) for el in root_dict.elements
        )
        if not root_all_dicts:
            continue
        # All flows are made up of dicts (nodes)
        flow_dicts = [
            cst.ensure_type(el.value, cst.Dict)
            for el in root_dict.elements
            if not m.matches(el, m.DictElement(key=m.Name("GLOBAL")))
        ]
        flows_all_have_dicts = all(
            isinstance(el.value, cst.Dict)
            for flow in flow_dicts
            for el in flow.elements
        )
        if not flows_all_have_dicts:
            continue
        # All nodes have TRANSITIONS key
        nodes = [
            cst.ensure_type(el.value, cst.Dict)
            for flow in flow_dicts
            for el in flow.elements
        ]
        all_nodes = all(
            any(
                m.matches(el, m.DictElement(key=m.Name("TRANSITIONS")))
                for el in node.elements
            )
            for node in nodes
        )
        if all_nodes:
            return root_dict


CollectionNode = Union[cst.Dict, cst.List]


class NodeVisitor(m.MatcherDecoratableTransformer):
    module: cst.Module
    update: DictUpdate
    path: List[Union[str, int]] = []
    indent_stack: List[str] = []

    @property
    def depth(self) -> int:
        return len(self.path)

    def __init__(self, update: DictUpdate, module: cst.Module):
        super().__init__()
        self.update = update
        self.module = module

    def get_target(self):
        current = self.update
        current_path = self.path.copy()
        while len(current_path) > 0:
            part = current_path.pop(0)
            if isinstance(current, DictUpdate) and isinstance(part, str):
                _, current = current.get(part)
            elif isinstance(current, ListUpdate) and isinstance(part, int):
                current = (
                    current.elements[part] if part < len(current.elements) else None
                )
            elif current is None:
                break
            else:
                raise ValueError(
                    f"Invalid path \"{'.'.join(str(i) for i in self.path)}\" in"
                )
        return current

    def get_delim_ws(
        self, node: CollectionNode, side: Union[Literal["l"], Literal["r"]]
    ):
        if isinstance(node, cst.Dict):
            if side == "l":
                return node.lbrace.whitespace_after
            else:
                return node.rbrace.whitespace_before
        else:
            if side == "l":
                return node.lbracket.whitespace_after
            else:
                return node.rbracket.whitespace_before

    def get_collection_indent(self, node: CollectionNode):
        left_ws = self.get_delim_ws(node, "l")
        is_expanded = len(m.findall(left_ws, m.Newline())) > 0
        if is_expanded and isinstance(left_ws, cst.ParenthesizedWhitespace):
            return left_ws.last_line.value, is_expanded
        return None, None

    def offset_indent(self, indent: str, offset: int) -> str:
        if offset < 0:
            return indent.replace(self.module.default_indent, "", abs(offset))
        else:
            return indent + (self.module.default_indent * offset)

    def new_element(
        self,
        target: Union[DictUpdate, ListUpdate],
        value: cst.BaseExpression,
        key: cst.BaseExpression = None,
    ):
        if isinstance(target, DictUpdate):
            if key is None:
                raise ValueError("Key is required for a dict element")
            return cst.DictElement(key, value)
        else:
            return cst.Element(value)

    def new_collection(self, target: Union[DictUpdate, ListUpdate]) -> CollectionNode:
        new_elements = []
        for key, update in target:
            if isinstance(update, ValueUpdate):
                new_value = update.parsed
            else:
                new_value = self.new_collection(update)
            key = cst.parse_expression(str(key))
            new_elements.append(self.new_element(target, value=new_value, key=key))

        NewNode = cst.Dict if isinstance(target, DictUpdate) else cst.List
        return NewNode(elements=new_elements)

    def format_collection(
        self,
        node: CollectionNode,
        base_indent: str,
        is_expanded: bool,
        has_trailing_comma: bool,
    ):
        if is_expanded:
            left_ws = self.get_delim_ws(node, "l")
            if isinstance(left_ws, cst.ParenthesizedWhitespace):
                left_ws = left_ws.with_changes(
                    indent=True,
                    last_line=cst.SimpleWhitespace(self.offset_indent(base_indent, +1)),
                )
            else:
                left_ws = cst.ParenthesizedWhitespace(
                    indent=True,
                    last_line=cst.SimpleWhitespace(self.offset_indent(base_indent, +1)),
                )

            right_ws = self.get_delim_ws(node, "r")
            if isinstance(right_ws, cst.ParenthesizedWhitespace):
                right_ws = right_ws.with_changes(
                    indent=True, last_line=cst.SimpleWhitespace(base_indent)
                )
            else:
                right_ws = cst.ParenthesizedWhitespace(
                    indent=True, last_line=cst.SimpleWhitespace(base_indent)
                )
        else:
            left_ws = cst.SimpleWhitespace("")
            right_ws = cst.SimpleWhitespace("")

        new_elements = []
        for el in node.elements:
            if el.comma != cst.MaybeSentinel.DEFAULT:
                if is_expanded:
                    if isinstance(
                        el.comma.whitespace_after, cst.ParenthesizedWhitespace
                    ):
                        new_comma = el.comma.with_changes(
                            whitespace_after=el.comma.whitespace_after.with_changes(
                                indent=True,
                                last_line=cst.SimpleWhitespace(
                                    self.offset_indent(base_indent, +1)
                                ),
                            )
                        )
                    else:
                        new_comma = el.comma.with_changes(
                            whitespace_after=cst.ParenthesizedWhitespace(
                                indent=True,
                                last_line=cst.SimpleWhitespace(
                                    self.offset_indent(base_indent, +1)
                                ),
                            )
                        )
                else:
                    new_comma = cst.Comma(whitespace_after=cst.SimpleWhitespace(" "))
                new_elements.append(el.with_changes(comma=new_comma))
            else:
                new_elements.append(el)
        if len(new_elements) > 0:
            new_elements[-1] = new_elements[-1].with_changes(
                comma=cst.Comma() if has_trailing_comma else cst.MaybeSentinel.DEFAULT
            )

        if isinstance(node, cst.List):
            return node.with_changes(
                elements=new_elements,
                lbracket=node.lbracket.with_changes(whitespace_after=left_ws),
                rbracket=node.rbracket.with_changes(whitespace_before=right_ws),
            )
        else:
            return node.with_changes(
                elements=new_elements,
                lbrace=node.lbrace.with_changes(whitespace_after=left_ws),
                rbrace=node.rbrace.with_changes(whitespace_before=right_ws),
            )

    # Do not enter non collection nodes
    def on_visit(self, node: cst.CSTNode) -> bool:
        should_visit = super().on_visit(node)
        if not m.matches(node, m.Dict() | m.List() | m.DictElement() | m.Element()):
            should_visit = False
        return should_visit

    # Keeping track of our current path inside the flow
    def visit_DictElement(self, node: cst.DictElement):
        if isinstance(node.key, (cst.Name, cst.SimpleString)):
            self.path.append(node.key.value)
        else:
            self.path.append("")
            return False

    def leave_DictElement(self, _, updated: cst.DictElement):
        self.path.pop()
        return updated

    @m.visit(m.Dict() | m.List())
    def count_indent(self, node: CollectionNode):
        indent, _ = self.get_collection_indent(node)
        if indent is not None:
            self.indent_stack.append(indent)

    # Actual transform
    @m.leave(m.Dict() | m.List())
    def update_collection(self, original, node: CollectionNode) -> CollectionNode:
        indent, is_expanded = self.get_collection_indent(node)
        if indent == self.indent_stack[-1]:
            base_indent = self.offset_indent(self.indent_stack.pop(), -1)
        else:
            base_indent = self.indent_stack[-1] if len(self.indent_stack) > 0 else ""
        sys.stderr.write(f"{'.'.join(str(i) for i in self.path)}: {len(base_indent)/len(self.module.default_indent)}\n")

        target = self.get_target()
        sys.stderr.write(
            f"transforming node {type(node)} in path {'.'.join(str(i) for i in self.path)}, update: {type(target)}\n"
        )
        if target is None:
            sys.stderr.write(f"code for updated node: {self.module.code_for_node(node)}\n")
            return node

        if isinstance(target, DictUpdate) and not isinstance(node, cst.Dict):
            raise TypeError(
                f"Got DictUpdate but node is not a dictionary!\nNode: {node}\nUpdate: {target}"
            )
        if isinstance(target, ListUpdate) and not isinstance(node, cst.List):
            raise TypeError(
                f"Got ListUpdate but node is not a list!\nNode: {node}\nUpdate: {target}"
            )
        if not isinstance(target, (ListUpdate, DictUpdate)):
            raise TypeError(
                f"Got ValueUpdate for a collection!\nNode: {node}\nUpdate: {target}"
            )

        has_trailing_comma = False
        if len(original.elements) > 0:
            has_trailing_comma = (
                original.elements[-1].comma != cst.MaybeSentinel.DEFAULT
            )

        new_elements = []
        for el in node.elements:
            key = el.key if isinstance(el, cst.DictElement) else el.value
            update = target.pop(key)
            if isinstance(update, ValueUpdate):
                if update != el.value:
                    # Update element
                    new_el = el.with_changes(value=update.parsed)
                    new_elements.append(new_el)
                else:
                    # Unchanged
                    new_elements.append(el)
            elif isinstance(update, (DictUpdate, ListUpdate)):
                new_elements.append(el)
            elif update is None and target.allow_extra:
                # Not in update, but extra is allowed
                new_elements.append(el)

        right_ws = self.get_delim_ws(node, "r")
        if len(new_elements) > 0:
            comma = cst.Comma(whitespace_after=right_ws.deep_clone())
            new_elements[-1] = new_elements[-1].with_changes(comma=comma)
        if len(target.elements) > 0:
            right_ws = cst.SimpleWhitespace("")

        sys.stderr.write(f"Remaining {target.elements}\n")
        # Remaining elements
        for key, update in target:
            key = (
                cst.parse_expression(str(key)) if key != "" else cst.SimpleString('""')
            )
            if isinstance(update, ValueUpdate):
                upd_attrs = dict(value=update.parsed)
                if isinstance(target, DictUpdate):
                    upd_attrs["key"] = key
                if len(new_elements) != 0:
                    new_el = new_elements[-1].with_changes(**upd_attrs)
                elif len(node.elements) != 0:
                    new_el = node.elements[0].with_changes(**upd_attrs)
                else:
                    new_el = self.new_element(target, **upd_attrs)
                new_elements.append(new_el)
            else:
                new_val = self.new_collection(update)
                new_el = self.new_element(target, key=key, value=new_val)
                indent = self.offset_indent(base_indent, +1)
                line_len = len(self.module.code_for_node(new_el)) + len(indent)
                if line_len > 80:
                    new_val = self.format_collection(
                        new_val, indent, True, has_trailing_comma
                    )
                    new_el = new_el.with_changes(value=new_val)
                new_elements.append(new_el)

        ws_dict = {}
        if isinstance(node, cst.Dict):
            ws_dict["rbrace"] = cst.RightCurlyBrace(right_ws)
        else:
            ws_dict["rbracket"] = cst.RightSquareBracket(right_ws)
        node = node.with_changes(elements=new_elements, **ws_dict)
        if not is_expanded:
            line_len = max(
                (len(l) for l in self.module.code_for_node(node).splitlines())
            )
            is_expanded = line_len > 80
        node = self.format_collection(
            node, base_indent, is_expanded, is_expanded and has_trailing_comma
        )

        sys.stderr.write(f"code for updated node: {self.module.code_for_node(node)}\n")
        return node
