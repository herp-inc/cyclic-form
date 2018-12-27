import { VNode } from '@cycle/dom';
import { Scope } from '@cycle/dom/lib/es6/isolate';
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

export function form<Decl extends FormDeclaration<any>>(
    fields: FieldsFor<Decl>,
): Component<Sources<Decl>, Sinks<Decl>> {
    return function Form({
        DOM,
        state,
        renderer$,
        validators$ = Stream.of({}).remember(),
    }: Sources<Decl>): Sinks<Decl> {
        const { isolateSource } = DOM;
        const touchedKeys = new Set<keyof Decl>();

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

                        return [key, totalIsolateVNode(vnode, DOM.namespace, key)];
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

        return {
            DOM: vnode$,
            state: reducer$,
            submission$: DOM.select('form').events('submit', { preventDefault: true }),
        };
    };
}

// copied from https://github.com/cyclejs/cyclejs/blob/90645d669f360edd792618e42512ea0d90da189a/dom/src/isolate.ts#L24-L46
// couldn't be imported as it is originally used within map() function
function totalIsolateVNode(node: VNode, namespace: Scope[], scope: string) {
    if (!node) {
        return node;
    }
    const scopeObj: Scope = { type: 'total', scope };
    const newNode = {
        ...node,
        data: {
            ...node.data,
            isolate: !node.data || !Array.isArray(node.data.isolate) ? namespace.concat([scopeObj]) : node.data.isolate,
        },
    };
    return {
        ...newNode,
        key: newNode.key !== undefined ? newNode.key : JSON.stringify(newNode.data.isolate),
    };
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
