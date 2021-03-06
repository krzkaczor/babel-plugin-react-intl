/*
 * Copyright 2015, Yahoo Inc.
 * Copyrights licensed under the New BSD License.
 * See the accompanying LICENSE file for terms.
 */

import * as p from 'path';
import {writeFileSync} from 'fs';
import {sync as mkdirpSync} from 'mkdirp';
import printICUMessage from './print-icu-message';

const COMPONENT_NAMES = [
    'FormattedMessage',
    'FormattedHTMLMessage',
];

const FUNCTION_NAME = 'formatIntlMessage';

const DESCRIPTOR_PROPS = new Set(['id', 'description', 'defaultMessage']);

const EXTRACTED = Symbol('ReactIntlExtracted');
const MESSAGES  = Symbol('ReactIntlMessages');

export default function () {
    function evaluatePath(path) {
        const evaluated = path.evaluate();
        if (evaluated.confident) {
            return evaluated.value;
        }

        throw path.buildCodeFrameError(
            '[React Intl] Messages must be statically evaluate-able for extraction.'
        );
    }

    function getMessageDescriptorKey(path) {
        if (path.isIdentifier() || path.isJSXIdentifier()) {
            return path.node.name;
        }

        return evaluatePath(path);
    }

    function getMessageDescriptorValue(path) {
        if (path.isJSXExpressionContainer()) {
            path = path.get('expression');
        }

        // Always trim the Message Descriptor values.
        const descriptorValue = evaluatePath(path);

        if (typeof descriptorValue === 'string') {
            return descriptorValue.trim();
        }

        return descriptorValue;
    }

    function getICUMessageValue(messagePath, {isJSXSource = false} = {}) {
        const message = getMessageDescriptorValue(messagePath);

        try {
            return printICUMessage(message);
        } catch (parseError) {
            if (isJSXSource &&
                messagePath.isLiteral() &&
                message.indexOf('\\\\') >= 0) {

                throw messagePath.buildCodeFrameError(
                    '[React Intl] Message failed to parse. ' +
                    'It looks like `\\`s were used for escaping, ' +
                    'this won\'t work with JSX string literals. ' +
                    'Wrap with `{}`. ' +
                    'See: http://facebook.github.io/react/docs/jsx-gotchas.html'
                );
            }

            throw messagePath.buildCodeFrameError(
                '[React Intl] Message failed to parse. ' +
                'See: http://formatjs.io/guides/message-syntax/' +
                `\n${parseError}`
            );
        }
    }

    function createMessageDescriptor(propPaths) {
        return propPaths.reduce((hash, [keyPath, valuePath]) => {
            const key = getMessageDescriptorKey(keyPath);

            if (DESCRIPTOR_PROPS.has(key)) {
                hash[key] = valuePath;
            }

            return hash;
        }, {});
    }

    function evaluateMessageDescriptor({...descriptor}, {isJSXSource = false} = {}) {
        Object.keys(descriptor).forEach((key) => {
            const valuePath = descriptor[key];

            if (key === 'defaultMessage') {
                descriptor[key] = getICUMessageValue(valuePath, {isJSXSource});
            } else {
                descriptor[key] = getMessageDescriptorValue(valuePath);
            }
        });

        return descriptor;
    }

    function storeMessage({id, description, defaultMessage}, path, state) {
        const {file, opts} = state;

        const messages = file.get(MESSAGES);
        if (messages.has(id)) {
            const existing = messages.get(id);

            if (description !== existing.description ||
                defaultMessage !== existing.defaultMessage) {

                throw path.buildCodeFrameError(
                    `[React Intl] Duplicate message id: "${id}", ` +
                    'but the `description` and/or `defaultMessage` are different.'
                );
            }
        }

        if (opts.enforceDescriptions) {
            if (
                !description ||
                (typeof description === 'object' && Object.keys(description).length < 1)
            ) {
                throw path.buildCodeFrameError(
                    '[React Intl] Message must have a `description`.'
                );
            }
        }

        let loc;
        if (opts.extractSourceLocation) {
            loc = {
                file: p.relative(process.cwd(), file.opts.filename),
                ...path.node.loc,
            };
        }

        messages.set(id, {id, description, defaultMessage, ...loc});
    }

    function referencesImport(path, importedNames) {
        if (!(path.isIdentifier() || path.isJSXIdentifier())) {
            return false;
        }

        return importedNames.some((name) => path.node.name === name);
    }

    function tagAsExtracted(path) {
        path.node[EXTRACTED] = true;
    }

    function wasExtracted(path) {
        return !!path.node[EXTRACTED];
    }

    return {
        pre(file) {
            if (!file.has(MESSAGES)) {
                file.set(MESSAGES, new Map());
            }
        },

        post(file) {
            const {opts} = this;
            const {filename} = file.opts;

            const basename = p.basename(filename, p.extname(filename));
            const messages = file.get(MESSAGES);
            const descriptors = [...messages.values()];
            file.metadata['react-intl'] = {messages: descriptors};

            if (opts.messagesDir && descriptors.length > 0) {
                // Make sure the relative path is "absolute" before
                // joining it with the `messagesDir`.
                const relativePath = p.join(
                    p.sep,
                    p.relative(process.cwd(), filename)
                );

                const messagesFilename = p.join(
                    opts.messagesDir,
                    p.dirname(relativePath),
                    basename + '.json'
                );

                const messagesFile = JSON.stringify(descriptors, null, 2);

                mkdirpSync(p.dirname(messagesFilename));
                writeFileSync(messagesFilename, messagesFile);
            }
        },

        visitor: {
            JSXOpeningElement(path, state) {
                if (wasExtracted(path)) {
                    return;
                }

                const {file} = state;
                const name = path.get('name');

                if (name.referencesImport('FormattedPlural')) {
                    file.log.warn(
                        `[React Intl] Line ${path.node.loc.start.line}: ` +
                        'Default messages are not extracted from ' +
                        '<FormattedPlural>, use <FormattedMessage> instead.'
                    );

                    return;
                }

                if (referencesImport(name, COMPONENT_NAMES)) {
                    const attributes = path.get('attributes')
                        .filter((attr) => attr.isJSXAttribute());

                    let descriptor = createMessageDescriptor(
                        attributes.map((attr) => [
                            attr.get('name'),
                            attr.get('value'),
                        ])
                    );

                    // In order for a default message to be extracted when
                    // declaring a JSX element, it must be done with standard
                    // `key=value` attributes. But it's completely valid to
                    // write `<FormattedMessage {...descriptor} />` or
                    // `<FormattedMessage id={dynamicId} />`, because it will be
                    // skipped here and extracted elsewhere. The descriptor will
                    // be extracted only if a `defaultMessage` prop exists.
                    // Evaluate the Message Descriptor values in a JSX
                    // context, then store it.
                    descriptor = evaluateMessageDescriptor(descriptor, {
                        isJSXSource: true,
                    });

                    storeMessage(descriptor, path, state);

                    // Remove description since it's not used at runtime.
                    attributes.some((attr) => {
                        const ketPath = attr.get('name');
                        if (getMessageDescriptorKey(ketPath) === 'description') {
                            attr.remove();
                            return true;
                        }
                    });

                    // Tag the AST node so we don't try to extract it twice.
                    tagAsExtracted(path);
                }
            },

            CallExpression(path, state) {
                const callee = path.get('callee');

                if (callee.node.name === FUNCTION_NAME || (callee.node.property && callee.node.property.name === FUNCTION_NAME)) {
                    const messageObj = path.get('arguments')[0];
                    const value = messageObj.node.value;

                    if (wasExtracted(messageObj)) {
                        return;
                    }

                    storeMessage({ id:value } , messageObj, state);
                    tagAsExtracted(messageObj);
                }
            },
        },
    };
}
