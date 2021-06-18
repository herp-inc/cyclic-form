import { MainDOMSource, VNode } from '@cycle/dom';
import { Component } from '@cycle/isolate';
import { Lens, StateSource } from '@cycle/state';
import { MemoryStream, Stream } from 'xstream';

export type Endo<A> = (x: A) => A;

// sources and sinks

/**
 * Source streams of a form component.
 */
export type Sources<Decl extends FormDeclaration<any>> = {
    DOM: MainDOMSource;
    state: StateSource<Values<Decl>>;
    renderer$: MemoryStream<FormRenderer<Decl>>;
    untouch$?: Stream<keyof Decl | null>;
    validators$?: MemoryStream<ValidatorsFor<Decl>>;
};

/**
 * Sink streams of a form component.
 */
export type Sinks<Decl extends FormDeclaration<any>> = {
    DOM: MemoryStream<VNode>;
    state: Stream<Endo<Values<Decl>>>;
    submission$: Stream<Event>;
};

// form / fields

/**
 * A form field consists of an `Intent` and a `View`.
 */
export type Field<T, Options extends FieldOptions<any> = FieldOptions<string>> = {
    intent: Intent<T>;
    view: View<T, Options>;
};

/**
 * An `Intent` defines how to change the field value by listening to user's actions.
 *
 * It takes a `MainDOMSource` as an argument and returns a stream of endomorphisms.
 * The value of the field can be modified (or set) through this stream.
 *
 * Note that the given `MainDOMSource` is isolated.
 *
 * ```
 * const intent: Intent<string> = (DOM: MainDOMSource) => DOM.select('input').events('input').map((e: any) => _ => e.target.value);
 * ```
 */
export type Intent<T> = (DOM: MainDOMSource) => Stream<Endo<T>>;

/**
 * A `View` defines how to tell the current state of the field to the user.
 *
 * It takes a `ViewInput`, which includes the current value, error message and so forth,
 * and converts it into a `VNode`.
 */
export type View<T, Options extends FieldOptions<any> = FieldOptions<string>> = (
    input: ViewInput<T, Options>,
    metaData: MetaData,
) => VNode;

/**
 * A data set represents the current status of a field.
 */
export type ViewInput<T, Options extends FieldOptions<any> = FieldOptions<string>> = {
    error?: Options['error'];
    touched: boolean;
    value: T;
};

export type FieldOptions<Err> = {
    error: Err;
};

/**
 * A helper (type-level) function which lifts the form value type to the form declaration type,
 * assuming every field reports its error with a `string` value.
 */
export type SimpleForm<Form> = { [FieldName in keyof Form]: FieldDeclaration<Form[FieldName], { error: string }> };

/**
 * A declaration of a single form field.
 */
export type FieldDeclaration<T, Options extends FieldOptions<any>> = {
    type: T;
    error: Options['error'];
};

/**
 * Defines what the entire form is look like.
 */
export type FormDeclaration<Values extends any> = {
    [FieldName in keyof Values]: FieldDeclaration<Values[FieldName], { error: any }>;
};

/**
 * Field implementations for the given `FormDeclaration`.
 */
export type FieldsFor<Form extends FormDeclaration<any>> = {
    [FieldName in keyof Form]?: Field<Form[FieldName]['type'], FieldOptions<Form[FieldName]['error']>>;
};

/**
 * Validators implementations for the given `FormDeclaration`.
 */
export type ValidatorsFor<Form extends FormDeclaration<any>> = {
    [FieldName in keyof Form]?: Form[FieldName]['error'] extends infer Err
        ? Validator<Form[FieldName]['type'], Err>
        : never;
};

/**
 * Takes a map from field names to the corresponding `VNode`, and returns a `VNode` of the entire form.
 *
 * it is a good practice to return a `VNode` of `form` element.
 */
export type FormRenderer<Form extends FormDeclaration<any>> = (vnodes: Record<keyof Form, VNode | null>) => VNode;

/**
 * Additional data representing the status of the entire form.
 *
 * This is actually passed to `View`s as the second argument.
 */
export type MetaData = {
    valid: boolean; // indicates whether the entire form is valid
};

/**
 * A type of a component obtained through state isolation.
 * Defined in order to avoid returning `Component<any, any>`.
 */
export type IsolatedForm<Parent, Child> = Component<
    Omit<Sources<FormDeclaration<Child>>, 'state'> & { state: StateSource<Parent> },
    Omit<Sinks<FormDeclaration<Child>>, 'state'> & { state: Stream<Endo<Parent>> }
>;

/**
 * Extracts the underlying form value type from a form declaration type.
 */
export type Values<Decl extends FormDeclaration<any>> = { [FieldName in keyof Decl]: Decl[FieldName]['type'] };

// validator

/**
 * `Validator<T, Err>` takes the value of type `T` and reports the error as `Err`, defaults to `string`.
 * It **must** return `null` when there are no errors to report.
 */
export type Validator<T, Err = string> = (value: T) => Err | null;

/**
 * Extract the `Child` from the `Parent` using its key or a `Lens`.
 */
export type ZoomIn<Parent extends object, Scope extends Lens<Parent, any> | keyof Parent> = Scope extends Lens<
    Parent,
    infer Child
>
    ? Child
    : Scope extends keyof Parent
    ? Parent[Scope]
    : never;

// others

export type Omit<T, K> = Pick<T, Exclude<keyof T, K>>;
