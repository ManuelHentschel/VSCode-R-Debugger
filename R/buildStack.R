



# # buildStack() gathers information about current stackframes/scopes
# # structured as follows:

# interface stack{
#     frames: Stackframe[];
#     varLists: Variable[][];
# }
#
# interface StackFrame{
#     env: R-environment;
#     id: number;
#     name: string;
#     source: Source;
#     line: number;
#     scopes: Scope[];
# }
#
# interface Source{
#     name: string;
#     path: string;
# }
#
# interface Scope{
#     name: string;
#     variablesReference: number;
# }
#
# interface Variable{
#     name: string;
#     value: string;
#     type: string;
#     variablesReference: number;
# }




########################################################################
# Stack

buildStack <- function(topFrame = parent.frame()){
    frameIds <- 1:nFrames(topFrame)
    frames <- lapply(frameIds, getStackFrame)
    stack <- list(
        frames=frames,
        varLists=.varLists
    )
    return(stack)
}

nFrames <- function(topFrame){
    nFrames <- sys.nframe()
    while(!identical(sys.frame(nFrames), topFrame) && !identical(sys.frame(nFrames), .GlobalEnv)){
        nFrames <- nFrames -1
    }
    return(nFrames)
}


########################################################################
# StackFrames

getStackFrame <- function(frameId){
    env <- sys.frame(frameId)
    call <- sys.call(frameId)
    name <- getFrameName(call)
    source <- getSource(env, call)
    line <- getLine(env, call)
    frame <- list(
        env=env,
        id=frameId,
        name=name,
        source=source,
        line=line
    )
    scopes <- getScopes(frame)
    frame$scopes <- scopes
    return(frame)
}

getFrameName <- function(call){
    name <- capture.output(base::print(call))[1]
    return(name)
}

getSource <- function(env, call){
    fileName <- getSrcFilename(eval(call[[1]], envir=env))
    dirName <- getSrcDirectory(eval(call[[1]], envir=env))
    dirName <- normalizePath(dirName, winslash = '/')
    fullPath <- file.path(dirName, fileName)
    fullPath <- normalizePath(fullPath, winslash = '\\')
    fullPath <- toString(fullPath)

    source <- list(
        name = fileName,
        path = fullPath
    )
    return(source)
}

getLine <- function(env, call){
    return(0) #TODO
}


########################################################################
# Scopes

getScopes <- function(frame){
    envs <- getScopeEnvs(frame$env)
    scopes <- lapply(envs, getScope)
    return(scopes)
}

getScope <- function(env){
    name <- capture.output(str(env))[1]
    varRef <- getVarRefForEnv(env)
    scope <- list(
        name=name,
        variablesReference=varRef
    )
    return(scope)
}

getScopeEnvs <- function(firstenv=parent.frame(), lastenv=.GlobalEnv){
    env <- firstenv
    print(env)
    scopes <- list(env)
    while (!identical(env, lastenv) && !identical(env, emptyenv())) {
        env <- parent.env(env)
        scopes[[length(scopes) + 1]] <- env
    }
    return(scopes)
}

getVarRefForEnv <- function(env, maxVars=100){
    varnames <- ls(env)

    if(length(varnames)>maxVars && maxVars>0){
        varnames <- varnames[1:maxVars]
    }

    varList <- getVarList(varnames, env)
    varRef <- getVarRef(varList)
    return(varRef)
}

.varLists <- list()
getVarRef <- function(varList){
    if(length(varList)==0){
        varRef <- 0
    } else{
        varRef <- length(.varLists) + 1
        .varLists[[varRef]] <<- varList
    }
    return(varRef)
}


########################################################################
# Variables

getVarList <- function(names, scope){
    varList <- lapply(names, getVariableInScope, scope)
    return(varList)
}

getVariableInScope <- function(name, scope){
    variable <- try({
        valueR <- getValueR(name, scope)
        getVariable(valueR, name)
    }, silent=TRUE)
    if(class(variable)=='try-error'){
        variable <- getDummyVariable(name)
    }
    return(variable)
}


getDummyVariable <- function(name){
    variable <- list(
        name=name,
        value='???',
        type='???',
        variablesReference=0
    )
}

getVariable<- function(valueR, name, depth=5){
    value <- getValue(valueR)
    type <- getType(valueR)
    variableReference <- getVarRefForVar(valueR, depth)

    variable <- list(
        name=name,
        value=value,
        type=type,
        variableReference=variableReference,
        depth=depth
    )
    return(variable)
}

getValueR <- function(name, scope){
    valueR <- eval(parse(text=name), envir=scope)
    return(valueR)
}

getValue <- function(valueR){
    value <- varToString(valueR)
    return(value) # as string
}

varToString <- function(v){
    ret <- try(toString(v), silent = TRUE)
    if(class(ret) != 'try-error') return(ret)
    ret <- try({
        paste0(capture.output(v), collapse = ';\n')
    }, silent = TRUE)
    if(class(ret) != 'try-error') return(ret)
    return('???')
}

getType <- function(valueR){
    if(is.list(valueR)){
        return('list')
    } else if(is.vector(valueR) && length(valueR)>1){
        return('vector')
    } else if(is.matrix(valueR)){
        return('matrix')
    } else{
        return(typeof(valueR))
    }
}

getVarRefForVar <- function(valueR, depth) {
    varList <- getVarListForVar(valueR, depth)
    varRef <- getVarRef(varList)
    return(varRef)
}

getVarListForVar <- function(valueR, depth) {
    if(depth>0 && (is.list(valueR) || (is.vector(valueR) && length(valueR)>1))){
        valuesR <- valueR
        names <- names(valuesR)
        if(is.null(names)){
            names <- seq2(valuesR)
        }
        varList <- mapply(getVariable, valuesR, names, depth-1, SIMPLIFY=FALSE, USE.NAMES=FALSE)
        return(varList)
    } else{
        return(list())
    }
}


########################################################################
# Helper

seq2 <- function(from, to=NULL){
    if(is.null(from) || is.list(from) || (is.vector(from) && length(from)>1)){
        return(seq2(length(from)))
    } else if(is.null(to)){
        if(from==0){
            return(NULL)
        } else {
            return(seq(from))
        }
    } else if(from>to){
        return(NULL)
    } else{
        return(seq(from, to))
    }
}