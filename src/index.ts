import { VNode } from '@cycle/dom';
import { isolateSource } from '@cycle/dom/lib/cjs/isolate';
import { SCOPE_PREFIX } from '@cycle/dom/lib/cjs/utils';
import { Component, toIsolated } from '@cycle/isolate';
import { Lens } from '@cycle/state';
import { Endo, id } from 'jazz-func/endo';
import { MemoryStream, Stream } from 'xstream';

import {
    Field,
    FieldsFor,
    FormDeclaration,
    FormRenderer,
    IsolatedForm,
    Sinks,
    Sources,
    ValidatorsFor,
    Values,
    ZoomIn,
} from './types';

// re-exports
export {
    Field,
    FieldsFor,
    FieldDeclaration,
    FormDeclaration,
    FormRenderer,
    Intent,
    IsolatedForm,
    MetaData,
    Sinks,
    SimpleForm,
    Sources,
    Validator,
    ValidatorsFor,
    View,
    ViewInput,
} from './types';

export function isolate<State extends object, Scope extends Lens<State, any> | keyof State>(
    scope: Scope,
): (
    child: Component<Sources<FormDeclaration<ZoomIn<State, Scope>>>, Sinks<FormDeclaration<ZoomIn<State, Scope>>>>,
) => IsolatedForm<State, ZoomIn<State, Scope>> {
    if (typeof scope === 'string') {
        return toIsolated(scope) as any;
    } else {
        return toIsolated({ state: scope }) as any;
    }
}

export namespace Options {
    /**
     * Options for custom submission. 
     * - `predicate` is a function which defines what custom keybinds are. By default, 'Ctrl + Enter' and 'Metakey + Enter' are treated as submission keybinds.
     * - `fields` is the set of the form field which accepts custom keybinds.
     */
    export type CustomSubmission<Decl extends FormDeclaration<any>> = Readonly<{
        fields: Set<keyof Decl>;
        predicate(e: KeyboardEvent): boolean;
    }>;
}

/**
 * Options to customize form behavior
 * - `customSubmission` enables the form to be submitted by custom keybinds like 'Ctrl + Enter'.
 */
export type Options<Decl extends FormDeclaration<any>> = Readonly<{
    customSubmission: Options.CustomSubmission<Decl>;
}>;

/**
 * Form component constructor
 *
 * @example
 * form(fieldsConstructor(), {
 *   customSubmission: {
 *     // We can submit this form by pressing 'Ctrl + Enter' of 'Meta + Enter' while editing 'description' fields
 *     fields: new Set(['description']),
 *   },
 * })
 *
 */
export function form<Decl extends FormDeclaration<any>>(
    fields: FieldsFor<Decl>,
    options: Options<Decl> = { customSubmission: { fields: new Set<keyof Decl>(), predicate: defaultPredicate } },
): Component<Sources<Decl>, Sinks<Decl>> {
    return function Form({
        DOM,
        state,
        renderer$,
        validators$ = Stream.of({}).remember(),
    }: Sources<Decl>): Sinks<Decl> {
        const touchedKeys = new Set<keyof Decl>();

        const { customSubmission } = options;
        const { fields: submissionFields } = customSubmission;
        const { predicate } = customSubmission;
        const customSubmission$ = Stream.merge(
            ...Array.from(submissionFields).map(key =>
                isolateSource(DOM, key)
                    .events('keydown')
                    .filter(predicate),
            ),
        );

        Object.keys(fields).forEach((key: keyof Decl) => {
            const isolatedDOMSource = isolateSource(DOM, key);

            Stream.merge(
                isolatedDOMSource.events('change'),
                isolatedDOMSource.events('focus'),
                isolatedDOMSource.events('input'),
            )
                .take(1)
                .addListener({
                    next(_) {
                        touchedKeys.add(key);
                    },
                });
        });

        const combined$: Stream<[Decl, FormRenderer<Decl>, ValidatorsFor<Decl>]> = Stream.combine(
            state.stream,
            renderer$,
            validators$,
        );

        const reducer$s: Stream<Endo<Values<Decl>>>[] = Object.keys(fields).map((key: keyof Decl) => {
            const field: Field<Decl[keyof Decl]> | null | undefined = fields[key];

            if (!field) {
                return Stream.of(id);
            }

            const { intent } = field as Field<any>;
            const domSource = (field as any).shouldNotIsolate ? DOM : isolateSource(DOM, key);
            const endo$ = intent(domSource);

            return endo$.map((endo: Endo<Values<Decl>>) =>
                evolveC<Values<Decl>>({
                    [key]: endo,
                } as any),
            );
        });
        const reducer$: Stream<Endo<Values<Decl>>> = Stream.merge(...reducer$s);

        const vnode$: MemoryStream<VNode> = combined$
            .map(([values, renderer, validators]) => {
                const errors: Record<keyof Decl, string | null> = Object.keys(fields)
                    .map<[keyof Decl, string | null]>((key: keyof Decl) => {
                        const field: Field<Decl[keyof Decl]> | null | undefined = fields[key];
                        const validator: any = validators[key];

                        if (!field || !validator) {
                            return [key, null];
                        }

                        const value = values[key];
                        const error = validator ? validator(value) : null;

                        return [key, error];
                    })
                    .reduce(
                        (acc: Record<keyof Decl, string | null>, [key, error]: [keyof Decl, string | null]) =>
                            Object.assign({}, acc, { [key]: error }),
                        {} as Record<keyof Decl, string | null>,
                    );

                const allValid = Object.values(errors).every(e => e === null);

                // used for isolating sinks
                const makeIsolationKey = function(key: string) {
                    const namespace: string = (DOM as any)._namespace[0];
                    const prefix = namespace ? namespace.replace(SCOPE_PREFIX, '') : '';
                    return [prefix, key].filter(Boolean).join('-');
                };

                const vnodes: Record<keyof Decl, VNode | null> = Object.keys(fields)
                    .map<[keyof Decl, VNode | null]>((key: keyof Decl) => {
                        const field: Field<Decl[keyof Decl]> | null | undefined = fields[key];
                        const value: Decl[keyof Decl] = values[key];

                        if (!field) {
                            return [key, null];
                        }

                        // any because the validation result differs from field to field
                        const error: any = errors[key] || null;

                        const vnode = field.view(
                            {
                                error,
                                touched: touchedKeys.has(key),
                                value,
                            },
                            { valid: allValid },
                        );

                        return [key, totalIsolateVNode(vnode, makeIsolationKey(key))];
                    })
                    .reduce(
                        (acc: Record<keyof Decl, VNode | null>, [key, vnode]: [keyof Decl, VNode]) =>
                            Object.assign({}, acc, { [key]: vnode }),
                        {} as Record<keyof Decl, VNode | null>,
                    );

                const vnode = renderer(vnodes);

                return vnode;
            })
            .remember();

        const submission$ = Stream.merge(
            DOM.select('form').events('submit', { preventDefault: true }),
            customSubmission$,
        );
        return {
            DOM: vnode$,
            state: reducer$,
            submission$,
        };
    };
}

// copied from https://github.com/cyclejs/cyclejs/blob/6758f00d2004d9a5aee6e2c186b2b278e39fa4a8/dom/src/isolate.ts
// couldn't be imported as it is originally used within map() function
// modified a little bit to avoid a bug by sharing the same reference
function totalIsolateVNode(node: VNode, scope: string): VNode {
    node.sel += `.${scope}`;

    if (node.data && (node.data as any).isolate) {
        const isolateData = (node.data as any).isolate as string;
        const prevFullScopeNum = isolateData.replace(/(cycle|\-)/g, '');
        const fullScopeNum = scope.replace(/(cycle|\-)/g, '');

        if (isNaN(parseInt(prevFullScopeNum)) || isNaN(parseInt(fullScopeNum)) || prevFullScopeNum > fullScopeNum) {
            // > is lexicographic string comparison
            return node;
        }
    }

    // Insert up-to-date full scope in vnode.data.isolate, and also a key if needed
    node.data = Object.assign({}, node.data || {}, { isolate: scope });
    if (typeof node.key === 'undefined') {
        node.key = SCOPE_PREFIX + scope;
    }

    return node;
}

function evolveC<Struct extends object>(
    transformations: Partial<{ [P in keyof Struct]: Endo<Struct[P]> }>,
): Endo<Struct> {
    return function(struct: Struct): Struct {
        const newStruct: any = Object.create(null);

        Object.keys(struct).forEach((key: keyof Struct) => {
            const f = transformations[key];

            if (typeof f === 'undefined') {
                newStruct[key] = struct[key];
            } else {
                newStruct[key] = f(struct[key]);
            }
        });

        return newStruct as Struct;
    };
}

const ctrlEnter = (e: KeyboardEvent) => e.ctrlKey && e.key === 'Enter';
const metaEnter = (e: KeyboardEvent) => e.metaKey && e.key === 'Enter';
const defaultPredicate = (e: KeyboardEvent) => ctrlEnter(e) || metaEnter(e);
