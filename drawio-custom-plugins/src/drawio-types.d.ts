declare const Draw: {
    loadPlugin(handler: (ui: DrawioUI) => void): void;
};

declare const log: any;
declare class mxCellHighlight {
    constructor(graph: DrawioGraph, color: string, arg: number);

    public highlight(arg: DrawioCellState | null): void;
    public destroy(): void;
}

declare class mxResources {
    static parse(value: string): void;
    static get(key: string): string;
}

declare class mxMouseEvent {
    public readonly graphX: number;
    public readonly graphY: number;
}

declare const mxEvent: {
    DOUBLE_CLICK: string;
    // CHANGE: string;

    ADD: string;
    ADD_CELLS: string;
    ADD_OVERLAY: string;
    AFTER_PAINT: string;
    ALIGN_CELLS: string;
    BEFORE_PAINT: string;
    BEFORE_UNDO: string;
    BEGIN_UPDATE: string;
    CELL_CONNECTED: string;
    CELLS_ADDED: string;
    CELLS_FOLDED: string;
    CELLS_MOVED: string;
    CELLS_ORDERED: string;
    CELLS_REMOVED: string;
    CELLS_RESIZED: string;
    CELLS_TOGGLED: string;
    CHANGE: string;
    CLEAR: string;
    CONNECT: string;
    CONNECT_CELL: string;
    CONTINUE: string;
    DONE: string;
    DOWN: string;
    END_UPDATE: string;
    EXECUTE: string;
    FIRED: string;
    FLIP_EDGE: string;
    FOLD_CELLS: string;
    GROUP_CELLS: string;
    INSERT: string;
    LABEL_CHANGED: string;
    LAYOUT_CELLS: string;
    MARK: string;
    MOVE_CELLS: string;
    NOTIFY: string;
    ORDER_CELLS: string;
    PAINT: string;
    REDO: string;
    REMOVE_CELLS: string;
    REMOVE_CELLS_FROM_PARENT: string;
    REMOVE_OVERLAY: string;
    REPAINT: string;
    RESIZE_CELLS: string;
    ROOT: string;
    SCALE: string;
    SCALE_AND_TRANSLATE: string;
    SELECT: string;
    SPLIT_EDGE: string;
    START: string;
    START_EDITING: string;
    STOP: string;
    TOGGLE_CELLS: string;
    TRANSLATE: string;
    UNDO: string;
    UNGROUP_CELLS: string;
    UP: string;
    UPDATE_CELL_SIZE: string;
};

declare const mxUtils: {
    isNode(node: any): node is HTMLElement;
    createXmlDocument(): XMLDocument;
};


declare interface DrawioUI {
    fileNode: Element | null;
    hideDialog(): void;
    showDialog(...args: any[]): void;
    editor: DrawioEditor;
    actions: DrawioActions;
    menus: DrawioMenus;
    importLocalFile(args: boolean): void;
}

interface DrawioMenus {
    get(name: string): any;
    addMenuItems(menu: any, arg: any, arg2: any): void;
}

interface DrawioActions {
    addAction(name: string, action: () => void): void;
    get(name: string): { funct: () => void };
}

declare interface DrawioEditor {
    graph: DrawioGraph;
}

declare interface DrawioGraph {
    defaultThemeName: string;
    insertVertex(arg0: undefined, arg1: null, label: string, arg3: number, arg4: number, arg5: number, arg6: number, arg7: string): void;
    addListener: any;
    model: DrawioGraphModel;
    getLabel(cell: DrawioCell): string;
    getSelectionModel(): DrawioGraphSelectionModel;
    view: DrawioGraphView;

    addMouseListener(listener: {
        mouseMove?: (graph: DrawioGraph, event: mxMouseEvent) => void;
        mouseDown?: (graph: DrawioGraph, event: mxMouseEvent) => void
        mouseUp?: (graph: DrawioGraph, event: mxMouseEvent) => void;
    }): void;
}

declare interface DrawioGraphView {
    getState(cell: DrawioCell): DrawioCellState;
    canvas: SVGElement;
}

declare interface DrawioCellState {
    cell: DrawioCell;
}

declare interface DrawioGraphSelectionModel {
    addListener(event: string, handler: (...args: any[]) => void): void;
    cells: DrawioCell[];
}

declare interface DrawioCell {
    id: string;
    style: string
}

declare interface DrawioGraphModel {
    setValue(c: DrawioCell, label: string | any): void;
    beginUpdate(): void;
    endUpdate(): void;
    cells: Record<any, DrawioCell>;
    setStyle(cell: DrawioCell, style: string): void;
    isVertex(cell: DrawioCell): boolean;
}