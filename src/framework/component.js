import assert from "./assert.js";
import { subscribeToSetHook } from "./watcher.js";
import {
    invokeComponentConstructor,
    invokeComponentRenderMethod,
} from "./invoker.js";
import {
    getComponentDef,
    internal,
} from "./def.js";
import {
    isRendering,
    vmBeingRendered,
    vmBeingCreated,
    invokeComponentAttributeChangedCallback,
} from "./invoker.js";
import {
    hookComponentLocalProperty,
    getPropertyProxy,
} from "./properties.js";
import {
    defineProperty,
    getPrototypeOf,
    getOwnPropertyDescriptor,
    getOwnPropertyNames,
    setPrototypeOf,
} from "./language.js";

function hookComponentReflectiveProperty(vm: VM, propName: string) {
    const { cache: { component, cmpProps, def: { props: publicPropsConfig } } } = vm;
    assert.block(() => {
        const target = getPrototypeOf(component);
        const { get, set } = getOwnPropertyDescriptor(component, propName) || getOwnPropertyDescriptor(target, propName);
        assert.invariant(get[internal] && set[internal], `component ${vm} has tampered with property ${propName} during construction.`);
    });
    defineProperty(component, propName, {
        get: (): any => {
            const value = cmpProps[propName];
            if (isRendering) {
                subscribeToSetHook(vmBeingRendered, cmpProps, propName);
            }
            return (value && typeof value === 'object') ? getPropertyProxy(value) : value;
        },
        set: (newValue: any) => {
            assert.invariant(false, `Property ${propName} of ${vm} cannot be set to ${newValue} because it is a public property controlled by the owner element.`);
        },
        configurable: true,
        enumerable: true,
    });
    // this guarantees that the default value is always in place before anything else.
    const { initializer } = publicPropsConfig[propName];
    const defaultValue = typeof initializer === 'function' ? initializer(): initializer;
    cmpProps[propName] = defaultValue;
}

function initComponentProps(vm: VM) {
    assert.vm(vm);
    const { cache } = vm;
    const { component, cmpProps, def: { props: publicPropsConfig, observedAttrs } } = cache;
    // reflective properties
    for (let propName in publicPropsConfig) {
        hookComponentReflectiveProperty(vm, propName);
    }
    // non-reflective properties
    getOwnPropertyNames(component).forEach((propName: string) => {
        if (propName in publicPropsConfig) {
            return;
        }
        hookComponentLocalProperty(vm, propName);
    });

    // notifying observable attributes if they are initialized with default or custom value
    for (let propName in publicPropsConfig) {
        const {  attrName } = publicPropsConfig[propName];
        const defaultValue = cmpProps[propName];
        // default value is an engine abstraction, and therefore should be treated as a regular
        // attribute mutation process, and therefore notified.
        if (defaultValue !== undefined && observedAttrs[attrName]) {
            invokeComponentAttributeChangedCallback(vm, attrName, undefined, defaultValue);
        }
    }
}

function clearListeners(vm: VM) {
    assert.vm(vm);
    const { cache: { listeners } } = vm;
    listeners.forEach((propSet: Set<VM>): boolean => propSet.delete(vm));
    listeners.clear();
}

export function updateComponentProp(vm: VM, propName: string, newValue: any) {
    assert.vm(vm);
    const { cache } = vm;
    const { cmpProps, def: { props: publicPropsConfig, observedAttrs } } = cache;
    assert.invariant(!isRendering, `${vm}.render() method has side effects on the state of ${vm}.${propName}`);
    const config = publicPropsConfig[propName];
    if (!config) {
        // TODO: ignore any native html property
        console.warn(`Updating unknown property ${propName} of ${vm}. This property will be a pass-thru to the DOM element.`);
    }
    if (newValue === undefined && config) {
        // default prop value computed when needed
        const initializer = config[propName].initializer;
        newValue = typeof initializer === 'function' ? initializer() : initializer;
    }
    let oldValue = cmpProps[propName];
    if (oldValue !== newValue) {
        cmpProps[propName] = newValue;
        if (config) {
            const attrName = config.attrName;
            if (observedAttrs[attrName]) {
                invokeComponentAttributeChangedCallback(vm, attrName, oldValue, newValue);
            }
        }
        console.log(`Marking ${vm} as dirty: property "${propName}" set to a new value.`);
        if (!cache.isDirty) {
            markComponentAsDirty(vm);
        }
    }
}

export function resetComponentProp(vm: VM, propName: string) {
    assert.vm(vm);
    const { cache } = vm;
    const { cmpProps, def: { props: publicPropsConfig, observedAttrs } } = cache;
    assert.invariant(!isRendering, `${vm}.render() method has side effects on the state of ${vm}.${propName}`);
    const config = publicPropsConfig[propName];
    let oldValue = cmpProps[propName];
    let newValue = undefined;
    if (!config) {
        // TODO: ignore any native html property
        console.warn(`Resetting unknown property ${propName} of ${vm}. This property will be a pass-thru to the DOM element.`);
    } else {
        const initializer = config[propName].initializer;
        newValue = typeof initializer === 'function' ? initializer() : initializer;
    }
    if (oldValue !== newValue) {
        cmpProps[propName] = newValue;
        if (config) {
            const attrName = config.attrName;
            if (observedAttrs[attrName]) {
                invokeComponentAttributeChangedCallback(vm, attrName, oldValue, newValue);
            }
        }
        console.log(`Marking ${vm} as dirty: property "${propName}" set to its default value.`);
        if (!cache.isDirty) {
            markComponentAsDirty(vm);
        }
    }
}

export function updateComponentSlots(vm: VM, newSlots: Array<vnode>) {
    // TODO: in the future, we can optimize this more, and only
    // set as dirty if the component really need slots, and if the slots has changed.
    console.log(`Marking ${vm} as dirty: [slotset] value changed.`);
    if (!vm.cache.isDirty) {
        markComponentAsDirty(vm);
    }
}

export function createComponent(vm: VM) {
    assert.vm(vm);
    assert.invariant(vm.elm instanceof HTMLElement, 'Component creation requires a DOM element to be associated to it.');
    const { Ctor, sel } = vm;
    console.log(`<${Ctor.name}> is being initialized.`);
    const def = getComponentDef(Ctor);
    const cache = {
        isScheduled: false,
        isDirty: true,
        def,
        context: {},
        privates: {},
        cmpProps: {},
        component: null,
        fragment: undefined,
        shadowRoot: null,
        listeners: new Set(),
    };
    assert.block(() => {
        const proto = {
            toString: (): string => {
                return `<${sel}>`;
            },
        };
        setPrototypeOf(vm, proto);
    });
    vm.cache = cache;
    cache.component = invokeComponentConstructor(vm);
    initComponentProps(vm);
}

export function renderComponent(vm: VM) {
    assert.vm(vm);
    const { cache } = vm;
    assert.invariant(cache.isDirty, `Component ${vm} is not dirty.`);
    console.log(`${vm} is being updated.`);
    clearListeners(vm);
    const vnodes = invokeComponentRenderMethod(vm);
    cache.isDirty = false;
    cache.fragment = vnodes;
    assert.invariant(Array.isArray(vnodes), 'Render should always return an array of vnodes instead of ${children}');
}

export function destroyComponent(vm: VM) {
    assert.vm(vm);
    clearListeners(vm);
}

export function markComponentAsDirty(vm: VM) {
    assert.vm(vm);
    assert.isFalse(vm.cache.isDirty, `markComponentAsDirty(${vm}) should not be called when the componet is already dirty.`);
    assert.isFalse(isRendering, `markComponentAsDirty(${vm}) cannot be called during rendering.`);
    vm.cache.isDirty = true;
}

const ComponentToVMMap = new WeakMap();

export function setLinkedVNode(component: Component, vm: VM) {
    assert.vm(vm);
    assert.isTrue(vm.elm instanceof HTMLElement, `Only DOM elements can be linked to their corresponding component.`);
    ComponentToVMMap.set(component, vm);
}

export function getLinkedVNode(component: Component): VM {
    assert.isTrue(component);
    // note to self: we fallback to `vmBeingCreated` in case users
    // invoke something during the constructor execution, in which
    // case this mapping hasn't been stable yet, but we know that's
    // the only case.
    const vm = ComponentToVMMap.get(component) || vmBeingCreated;
    assert.invariant(vm, `There have to be a VM associated to component ${component}.`);
    return vm;
}