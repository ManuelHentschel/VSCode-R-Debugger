

export type unnamedRArg = (number|string|boolean|undefined);
export type unnamedRArgs = (unnamedRArg|rList)[];
export type namedRArgs = {[arg:string]: unnamedRArg|rList};
export type rList = (unnamedRArgs|namedRArgs);
export type anyRArgs = (unnamedRArg|unnamedRArgs|namedRArgs);


/////////////////////////////////////////////////
// Construction of R function calls

export function makeFunctionCall(
    fnc: string, args: anyRArgs=[], args2: anyRArgs=[],
    escapeStrings: boolean=true, library: string = '', append: string = ''
): string{
    // args and args2 are handled identically and only necessary when combining named and unnamed arguments
    args = convertToUnnamedArgs(convertArgsToStrings(args, escapeStrings));
    args2 = convertToUnnamedArgs(convertArgsToStrings(args2, escapeStrings));
    args = args.concat(args2);
    const argString = args.join(',');

    if(library !== ''){
        library = library + '::';
    }

    // construct and execute function-call
    const cmd = library + fnc + '(' + argString + ')' + append;
    return cmd;
}

function convertArgsToStrings(args:anyRArgs=[], escapeStrings:boolean = false): anyRArgs {
    // Recursively converts all atomic arguments to strings, without changing the structure of arrays/lists
    if(Array.isArray(args)){
        //unnamedRArgs
        args = args.map((arg) => convertArgsToStrings(arg, escapeStrings));
    } else if(args!==null && typeof args === 'object'){
        //namedRArgs
        const ret = {};
        for(const arg in <namedRArgs>args){
            if(arg.substr(0,2)==='__'){
                console.warn('Ignoring argument: ' + arg);
            } else{
                ret[arg] = convertArgsToStrings(args[arg], escapeStrings);
            }
        }
        args = ret;
    } else if(args === undefined){
        //undefined
        args = 'NULL';
    } else if(typeof args === 'boolean'){
        //boolean
        if(args){
            args = 'TRUE';
        } else{
            args = 'FALSE';
        }
    } else if(typeof args === 'number'){
        //number
        args = '' + args;
    } else {
        //string
        if(escapeStrings){
            args = escapeStringForR(<string>args);
        }
    }
    return(args);
}

export function escapeStringForR(s: string, quote: string='"') {
    if (s === undefined) {
        return "NULL";
    } else {
        return(
            quote
            + s.replace(/\\/g, "\\\\")
                .replace(RegExp(quote, "g"), `\\${quote}`)
                .replace(/\n/g, "\\n")
                // .replace(/\r/g, "\\r")
                .replace(/\r/g, "")
                .replace(/\t/g, "\\t")
                .replace(/\f/g, "\\f")
                .replace(/\v/g, "\\v")
            + quote);
    }
}

function convertToUnnamedArgs(args: anyRArgs): unnamedRArgs{
    // converts anyRArgs to unnamed args by recursively converting named args "{key: arg}" to "key=arg"
    var ret: unnamedRArgs;
    if(Array.isArray(args)){
        // might be a nested list -> call recursively
        ret = args.map(convertToUnnamedArg);
    } else if(args!==null && typeof args === 'object'){
        ret = [];
        for(const arg in <namedRArgs>args){
            // again, each args[arg] might be a list itself
            ret.push(arg + '=' + convertToUnnamedArg(args[arg]));
        }
    } else{
        ret = [<unnamedRArg>args];
    }
    return ret;
}

function convertToUnnamedArg(arg: unnamedRArg|rList): unnamedRArg{
    // recursively converts an array of arguments to a single argument by turning it into a call to base::list()
    var ret: unnamedRArg;
    if(Array.isArray(arg)){
        // is rList
        ret = makeFunctionCall('list', arg, [], false,'base', '');
    } else if(arg!==null && typeof arg === 'object'){
        ret = makeFunctionCall('list', arg, [], false, 'base', '');
    } else{
        ret = <unnamedRArg>arg;
    }
    return ret;
}


