import { VNode, MainDOMSource } from '@cycle/dom';
import { Scope } from '@cycle/dom/lib/es6/isolate';
import { Component, toIsolated } from '@cycle/isolate';
import { Lens } from '@cycle/state';
import { MemoryStream, Stream } from 'xstream';

import {
    Endo,
    AnyEffectField,
    AnyEffectFieldsFor,
    AnyEffectFieldSinks,
    FieldDeclaration,
    FieldFor,
    FieldOptions,
    FieldsFor,
    FormDeclaration,
    IsolatedForm,
    Sinks,
    Sources,
    ValidatorsFor,
    Values,
    ZoomIn,
} from './types';

// re-exports
export {
    AnyEffectField,
    AnyEffectFieldFor,
    Field,
    FieldsFor,
    FieldDeclaration,
    FormDeclaration,
    FormRenderer,
    FieldOptions,
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

const id = <A>(x: A) => x;

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
 *     // We can submit this form by pressing 'Ctrl + Enter' while editing 'description' fields
 *     fields: new Set(['description']),
 *     predicate: (e: KeyboardEvent) => e.ctrlKey && e.key === 'Enter'
 *   },
 * })
 *
 */
export function form<Decl extends FormDeclaration<any>>(
    fields: FieldsFor<Decl>,
    options: Options<Decl> = { customSubmission: { fields: new Set<keyof Decl>(), predicate: defaultPredicate } },
): Component<Sources<Decl>, Sinks<Decl>> {
    return function Form(sources: Sources<Decl>): Sinks<Decl> {
        const {
            DOM,
            state,
            renderer$,
            untouch$ = Stream.never(),
            validators$ = Stream.of<ValidatorsFor<Decl>>({}).remember(),
        } = sources;

        const anyEffectFields: AnyEffectFieldsFor<Decl> = Object.fromEntries(
            Object.keys(fields).map((key: keyof Decl) => {
                const field = fields[key];
                if (field === undefined) {
                    return [key, undefined];
                } else if (typeof field === 'object') {
                    return [key, toAnyEffectField(field as FieldFor<any>)];
                } else {
                    return [key, field];
                }
            }),
        );

        // isolate DOM source only when supported
        const isolateSource =
            typeof DOM.isolateSource === 'function'
                ? DOM.isolateSource
                : (source: MainDOMSource, _scope: any) => source;

        const touchedKeys = new Set<keyof Decl>();
        const touchedKeys$ = Stream.merge(
            untouch$.map((key) => {
                if (key === null) {
                    touchedKeys.clear();
                } else {
                    touchedKeys.delete(key);
                }
                return touchedKeys;
            }),
            ...Object.keys(anyEffectFields).map((key: keyof Decl) => {
                const isolatedDOMSource = isolateSource(DOM, key);
                return Stream.merge(
                    isolatedDOMSource.events('change'),
                    isolatedDOMSource.events('focus'),
                    isolatedDOMSource.events('input'),
                )
                    .take(1)
                    .map((_) => {
                        touchedKeys.add(key);
                        return touchedKeys;
                    });
            }),
        ).startWith(touchedKeys);

        const { customSubmission } = options;
        const { fields: submissionFields } = customSubmission;
        const { predicate } = customSubmission;
        const customSubmission$ = Stream.merge(
            ...Array.from(submissionFields).map((key) => isolateSource(DOM, key).events('keydown').filter(predicate)),
        );

        const errors$ = Stream.combine(state.stream, validators$).map(([values, validators]) => {
            return Object.keys(anyEffectFields)
                .map<[keyof Decl, string | null]>((key: keyof Decl) => {
                    const field = anyEffectFields[key];
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
        });

        const allValid$ = errors$.map((errors) => Object.values(errors).every((e) => e === null));

        const fieldInstances = Object.fromEntries(
            Object.keys(anyEffectFields)
                .map((key: keyof Decl) => {
                    const field = anyEffectFields[key];
                    if (field === undefined) {
                        return [key, undefined];
                    }
                    const domSource = (field as any).shouldNotIsolate ? DOM : isolateSource(DOM, key);
                    return [
                        key,
                        field({
                            ...(sources as any),
                            DOM: domSource,
                            metadata: allValid$.map((allValid) => ({ valid: allValid })),
                            state: state.select(key),
                            error: errors$.map((errors) => errors[key]),
                            touched: touchedKeys$.map((touchedKeys) => touchedKeys.has(key)),
                        }),
                    ];
                })
                .filter(([_key, instance]) => instance !== undefined),
        ) as Record<keyof Decl, AnyEffectFieldSinks<any, {}>>;

        const reducer$s: Stream<Endo<Values<Decl>>>[] = Object.keys(anyEffectFields).map((key: keyof Decl) => {
            const fieldInstance = fieldInstances[key];

            if (!fieldInstance) {
                return Stream.of(id);
            }

            return fieldInstance.state.map((endo: Endo<Values<Decl>>) =>
                evolveC<Values<Decl>>({
                    [key]: endo,
                } as any),
            );
        });
        const reducer$: Stream<Endo<Values<Decl>>> = Stream.merge(...reducer$s);

        const vnode$: MemoryStream<VNode> = Stream.combine(
            renderer$,
            Stream.combine(
                ...Object.keys(fieldInstances).map((key: keyof Decl) =>
                    fieldInstances[key].DOM.map(
                        (vnode) =>
                            [
                                key,
                                vnode !== null ? totalIsolateVNode(vnode, (DOM as MainDOMSource).namespace, key) : null,
                            ] as const,
                    ),
                ),
            ).map((entries) => Object.fromEntries(entries) as Record<keyof Decl, VNode | null>),
        )
            .map(([renderer, vnodes]) => {
                const vnode = renderer(vnodes);

                return vnode;
            })
            .remember();

        const submission$ = Stream.merge(
            DOM.select('form').events('submit', { preventDefault: true }),
            customSubmission$,
        );

        const sinks: Record<string, Stream<any>[] | undefined> = {};
        Object.keys(fieldInstances).forEach((key: keyof Decl) => {
            const instances = fieldInstances[key];
            Object.keys(instances).forEach((sinkKey: keyof typeof instances) => {
                if (sinkKey === 'DOM' || sinkKey === 'state') {
                    return;
                }

                if (sinks[sinkKey] === undefined) {
                    sinks[sinkKey] = [];
                }

                sinks[sinkKey]!.push(instances[sinkKey] as any);
            });
        });

        const otherSinks = Object.fromEntries(
            Object.keys(sinks).map((key: keyof typeof sinks) => [key, Stream.merge(...sinks[key]!)] as const),
        );

        return {
            DOM: vnode$,
            state: reducer$,
            submission$,
            ...(otherSinks as any),
        };
    };
}

function toAnyEffectField<Decl extends FieldDeclaration<any, any, {}, {}>>(
    field: FieldFor<Decl>,
): AnyEffectField<Decl['type'], {}, {}, FieldOptions<Decl['error']>> {
    const result: AnyEffectField<any, {}, {}, any> = ({ DOM, metadata, state, error, touched }) => {
        const intent$ = field.intent(DOM);
        const vnode$ = Stream.combine(metadata, state.stream, error, touched).map(([metadata, state, error, touched]) =>
            field.view({ error, touched, value: state }, metadata),
        );

        return {
            state: intent$,
            DOM: vnode$,
        };
    };

    if ((field as any).shouldNotIsolate) {
        (result as any).shouldNotIsolate = (field as any).shouldNotIsolate;
    }

    return result;
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
    return function (struct: Struct): Struct {
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
