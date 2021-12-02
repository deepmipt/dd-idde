import {
	CancellationToken,
	CustomTextEditorProvider,
	Range,
	TextDocument,
	WebviewPanel,
	window,
	workspace,
	WorkspaceEdit,
	Uri
} from "vscode";
import formatter = require("xml-formatter");
import { DrawioEditorService } from "./DrawioEditorService";
import { JSDOM } from "jsdom";
import * as fs from 'fs';
import * as path from 'path';

export class DrawioEditorProviderText implements CustomTextEditorProvider {
	constructor(private readonly drawioEditorService: DrawioEditorService) {}

	public async resolveCustomTextEditor(
		document: TextDocument,
		webviewPanel: WebviewPanel,
		token: CancellationToken
	): Promise<void> {
		try {
			const readonlySchemes = new Set(["git", "conflictResolution"]);
			const isReadOnly = readonlySchemes.has(document.uri.scheme);

			const editor = await this.drawioEditorService.createDrawioEditorInWebview(
				webviewPanel,
				{
					kind: "text",
					document,
				},
				{ isReadOnly }
			);
			const drawioClient = editor.drawioClient;

			interface NormalizedDocument {
				equals(other: this): boolean;
			}

			function getNormalizedDocument(src: string): NormalizedDocument {
				try {
					var document = new JSDOM(src).window.document;
				} catch (e) {
					console.warn("Could not parse xml: ", e);
					return {
						equals: () => false,
					};
				}

				try {
					// If only those attributes have changed, we want to ignore this change
					const mxFile = document.getElementsByTagName("mxfile")[0];
					if (mxFile !== undefined) {
						mxFile.setAttribute("modified", "");
						mxFile.setAttribute("etag", "");
					}

					const mxGraphModel = document.getElementsByTagName(
						"mxGraphModel"
					)[0];
					if (mxGraphModel !== undefined) {
						mxGraphModel.setAttribute("dx", "");
						mxGraphModel.setAttribute("dy", "");
					}
				} catch (e) {
					console.error(e);
				}

				function trimText(node: any) {
					for (
						node = node.firstChild;
						node;
						node = node.nextSibling
					) {
						if (node.nodeType == 3) {
							node.textContent = node.textContent.trim();
						} else {
							trimText(node);
						}
					}
				}
				trimText(document);

				const html = [...document.children]
					.map((c) => c.innerHTML)
					.join("\n");

				const normalizedDoc = {
					html,
					equals(other: any) {
						return other.html === html;
					},
				};
				return normalizedDoc;
			}

			let lastDocument: NormalizedDocument = getNormalizedDocument(
				document.getText()
			);
			let isThisEditorSaving = false;

			workspace.onDidChangeTextDocument(async (evt) => {
				if (evt.document !== document) {
					return;
				}
				if (isThisEditorSaving) {
					// We don't want to integrate our own changes
					return;
				}
				if (evt.contentChanges.length === 0) {
					// Sometimes VS Code reports a document change without a change.
					return;
				}

				const newText = evt.document.getText();
				const newDocument = getNormalizedDocument(newText);
				if (newDocument.equals(lastDocument)) {
					return;
				}
				lastDocument = newDocument;

				await drawioClient.mergeXmlLike(newText);
			});

			drawioClient.onChange.sub(async ({ newXml }) => {
				// We format the xml so that it can be easily edited in a second text editor.

				// Storing previous XML to .drawio file
				/*
				var currfile = document.uri.path;
				var curr_parsed = path.parse(currfile);
				var xmlFile = path.join(curr_parsed.dir, curr_parsed.name + "_new.drawio")
				var xmlUri = Uri.file(xmlFile);
				fs.writeFile(xmlUri.fsPath, formatter(newXml), () => {
					console.log('XML stored to file')
				})*/

				let output: string;
				if (document.uri.path.endsWith(".svg")) {
					const svg = await drawioClient.exportAsSvgWithEmbeddedXml();
					newXml = svg.toString("utf-8");
					output = formatter(
						// This adds a host to track which files are created by this extension and which by draw.io desktop.
						newXml.replace(
							/^<svg /,
							() => `<svg host="65bd71144e" `
						)
					);
				} else if (document.uri.path.endsWith(".py")) {
					console.log('New XML:');
					console.log(newXml);
					output = document.getText();
					await drawioClient.convertDrawio2Py(newXml)
						.then(result => {
							output = result;
							//webviewPanel.webview.postMessage( { graphOperations: "rearrangeGraph" });
						})
						.catch(error => {
							console.log(error);
						}
					);
				} else {
					if (newXml.startsWith('<mxfile host="')) {
						newXml = newXml.replace(
							/^<mxfile host="(.*?)"/,
							() => `<mxfile host="65bd71144e"`
						);
					} else {
						// in case there is no host attribute
						newXml = newXml.replace(
							/^<mxfile /,
							() => `<mxfile host="65bd71144e"`
						);
					}

					output = formatter(
						// This normalizes the host
						newXml
					);
				}

				const newDocument = getNormalizedDocument(output);
				if (newDocument.equals(lastDocument)) {
					return;
				}
				lastDocument = newDocument;

				const workspaceEdit = new WorkspaceEdit();

				// TODO diff the new document with the old document and only edit the changes.
				workspaceEdit.replace(
					document.uri,
					new Range(0, 0, document.lineCount, 0),
					output
				);

				isThisEditorSaving = true;
				try {
					await workspace.applyEdit(workspaceEdit);
          await drawioClient.mergeXmlLike("")
				} finally {
					isThisEditorSaving = false;
				}
			});

			drawioClient.onSave.sub(async () => {
				await document.save();
			});

			drawioClient.onInit.sub(async () => {
				drawioClient.loadXmlLike(document.getText());
			});
		} catch (e) {
			window.showErrorMessage(`Failed to open diagram: ${e}`);
			throw e;
		}
	}
}
