library(stringr)
library(jsonlite)

# options(prompt = "<.vsc>")

options(prompt = "<#>")

.vsc.evalInFrame <- function(expr, frameId, id=0){
    env <- sys.frame(frameId + 1)
    ret <- capture.output(eval(parse(text=expr), envir=env))
    ret <- paste(ret, sep="", collapse="\n")
    .vsc.sendToVsc('eval', ret, id=id)
}

.vsc.listEnv <- function (firstenv=parent.frame(), lastenv=emptyenv()) {
    env <- firstenv
    envList <- list(env)
    while (!identical(env, lastenv) && !identical(env, emptyenv())) {
        env <- parent.env(env)
        envList[[length(envList) + 1]] <- env
    }
    return(envList)
}

.vsc.envAsString <- function(env) {
    capture.output(str(env))[1]
}

.vsc.callAsString <- function(call) {
    capture.output(print(call))[1]
}

.vsc.ls2 <- function(env = parent.frame()) {
    name <- ls(env)
    value <- c()
    for(n in name){
        value <- c(value, .vsc.describeVar(n, env))
    }
    d <- data.frame(name, value, row.names = NULL)
    return(d)
}

.vsc.describeEnvs <- function(firstenv=parent.frame(), lastenv=.GlobalEnv) {
    envList <- .vsc.listEnv(firstenv, lastenv)
    envNames <- lapply(envList, .vsc.envAsString)
    envContent <- lapply(envList, .vsc.ls2)
    ret <- list(envNames, envContent)
    return(ret)
}

.vsc.describeLs2 <- function(env = parent.frame(), envString = NULL, id=0) {
    if(!is.null(envString)){
        env <- .vsc.findEnvByString(envString)
    }
    d <- .vsc.describeEnvs(env)
    .vsc.sendToVsc('ls',d, id=id)
    # s <- toJSON(d)
    # cat(paste0('<v\\s\\c.vsc.ls2>', s, '</v\\s\\c.vsc.ls2>\n'))
}

.vsc.getScopes <- function(firstenv=parent.frame(), lastenv=.GlobalEnv, id=0) {
    envList <- .vsc.listEnv(firstenv, lastenv)
    ret <- lapply(envList, .vsc.envAsString)
    .vsc.sendToVsc('scopes', ret, id=id)
    # return(ret)
}

.vsc.findEnvByString <- function(envString, returnIfNotFound=emptyenv()){
    # envList <- .vsc.listEnv(parent.frame())
    envList <- c(sys.frames(), .vsc.listEnv())
    env <- returnIfNotFound
    for(env in envList){
        if(.vsc.envAsString(env) == envString){
            break
        }
    }
    return(env)
}

.vsc.getVariables <- function(envString = "", id=0){
    env <- .vsc.findEnvByString(envString)
    ret <- .vsc.ls2(env)
    .vsc.sendToVsc('variables', ret, id=id)
    # return(l)
}

.vsc.getFileName <- function(call, frame){
# .vsc.getFileName <- function(call){
    # ref <- attr(call, 'srcref')
    # file <- attr(ref, 'srcfile')

    # dirName <- file$wd
    # fileName <- file$fileName

    fileName <- getSrcFilename(eval(call[[1]], envir=frame))
    dirName <- getSrcDirectory(eval(call[[1]], envir=frame))
    dirName <- normalizePath(dirName, winslash = '/')
    fullPath <- file.path(dirName, fileName)
    fullPath <- normalizePath(fullPath, winslash = '\\')
    fullPath <- toString(fullPath)
    return(fullPath)
}

.vsc.getLineNumber <- function(call){
    ref <- attr(call, 'srcref')
    return(ref[1])
}

.vsc.getStack <- function(id=0){
    frames <- sys.frames()
    calls <- sys.calls()
    frames[length(frames)] <- NULL
    calls[length(calls)] <- NULL
    fileNames <- mapply(.vsc.getFileName, calls, frames)
    # fileNames <- lapply(calls, .vsc.getFileName)
    lineNumbers <- lapply(calls, .vsc.getLineNumber)
    frames <- lapply(frames, .vsc.envAsString)
    calls <- lapply(calls, .vsc.callAsString)
    ret <- list(calls=calls, frames=frames, fileNames=fileNames, lineNumbers=lineNumbers)
    .vsc.sendToVsc('stack', ret, id=id)
}

# .vsc.listEnvAsString <- function() {
#     l <- .vsc.listEnv()
#     p <- lapply(l, function(e) {
#         capture.output(str(e))[1]
#     })
#     return(p)
# }




# printEnv <- function() {
#     p <- .vsc.listEnvAsString()
#     for(pp in p){
#         cat(pp)
#         cat('\n')
#     }
# }

# printSecret <- function(...) {
#     stringList <- capture.output(print(...))
#     for(s in stringList) {
#         cat(paste0("<v\\s\\c>", s, "</v\\s\\c>\n"))
#     }
# }

.vsc.sendToVsc <- function(message, body="", id=0){
    s <- .vsc.makeStringForVsc(message, body, id)
    cat(s)
}

.vsc.makeStringForVsc <- function(message, body="", id=0, args=list()){
    .vsc.delimiter0 <- '<v\\s\\c>'
    .vsc.delimiter1 <- '</v\\s\\c>'
    l <- list(message=message, body=body, id=id, args=args)
    s <- toJSON(l, auto_unbox = TRUE)
    r <- paste0(
        .vsc.delimiter0,
        s,
        .vsc.delimiter1,
        '\n'
    )
    return(r)
}


.vsc.describeVar <- function(v, env=parent.frame()) {
    s <- tryCatch({
        l <- format(eval(parse(text=v), envir = env));
        s <- paste0(l, collapse = ' ');
        s <- str_replace_all(s, '\t', ' ');
        s <- str_replace_all(s, ' +', ' ');
        return(s)
    }, error = function(e) {
        '???'
    })
    return(s)
}




# describeLs <- function(env = parent.frame()) {
#     d <- .vsc.ls2(env)
#     .vsc.sendToVsc('ls',d)
#     # s <- toJSON(d)
#     # printEnv()
#     # cat(paste0('<v\\s\\cls>', s, '</v\\s\\cls>\n'))
# }

.vsc.runMain <- function() {
    .vsc.sendToVsc('go')
    main()
    .vsc.sendToVsc('end')
}



# !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
# GET file-name of current function:
# attr(attr(eval.parent(sys.call()[[1]]), 'srcref'), 'srcfile')
# attr(attr(attributes(eval.parent(sys.call()[[1]]))$original, 'srcref'), 'srcfile')


.vsc.mySetBreakpoint <- function(srcfile, lines, includePackages=TRUE){
    # helper function. used to loop through (potentially empty) lists
    seq2 <- function(from, to){
        if(from>to) return(c())
        return(seq(from, to))
    }

    # find steps, that correspond to the given line numbers
    stepList <- list()
    for(i in seq2(1,length(lines))){
        if(includePackages){
            lastenv <- emptyenv() # searches through package-envs as well
        } else {
            lastenv <- .GlobalEnv # searches only thourh 'user'-envs
        }
        refs <- findLineNum(srcfile, lines[i], lastenv=lastenv)
        if(length(refs)>0){
            step <- refs[[1]] # Ignore other refs?? In what cases are there >1 refs??
            found <- FALSE

            # check if the same function already has breakpoints:
            for(j in seq2(1,length(stepList))){
                #check if env and function are identical:
                if(identical(stepList[[j]]$name, step$name) && identical(stepList[[j]]$env, step$env)){ 
                    #append step$at to steplist[[j]]$at, etc.
                    stepList[[j]]$at[[length(stepList[[j]]$at)+1]] <- step$at 
                    stepList[[j]]$line[[length(stepList[[j]]$line)+1]] <- step$line 
                    stepList[[j]]$timediff[[length(stepList[[j]]$timediff)+1]] <- step$timediff 
                    found <- TRUE
                    break
                }
            }
            # add new functions to stepList
            if(!found){
                step$at <- list(step$at)
                step$line <- list(step$line)
                step$timediff <- list(step$timediff)
                stepList[[length(stepList)+1]] <- step
            }
        }
    }

    # loop through functions found above
    for(i in seq2(1, length(stepList))){
        step <- stepList[[i]]
        if(FALSE){
            tracer <- bquote({
                cat(paste0(.(step$filename), "#", .(step$line), "\n"))
                browser(skipCalls = 4L)
            })
        } else {
            func <- eval(parse(text=step$name), envir = step$env)

            # loop through breakpoints for each function
            for(j in seq2(1, length(step$at))){
                loc <- step$at[[j]]
                # insert calls to cat() and browser()
                catString <- paste0(
                    .vsc.makeStringForVsc('breakpoint'),
                    "debug at ", step$filename, '#', step$line[[j]], ": ?\n"
                )
                body(func)[[loc]] <- call('{',
                        # call('cat',paste0("<v\\s\\c>breakpoint</v\\s\\c>\ndebug at ", (step$filename), '#', step$line[[j]], ": ?\n")),
                        call('cat', catString),
                        quote(.doTrace(browser())),
                        body(func)[[loc]]
                )
            }
            # assign modified function to original environment
            # assign(step$name, func, envir = step$env)
            global <- identical(step$env, .GlobalEnv)
            methods:::.assignOverBinding(step$name, func, step$env, FALSE)
        }
    }
    return(invisible(stepList))
}

cat('sourced prep.R\n')