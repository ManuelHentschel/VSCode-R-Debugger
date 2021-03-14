
// mimic 'await-notify', but typed:

export class Subject {
    private waiters: Waiter[] = [];
    
    public notify(): void {
        for(const waiter of this.waiters){
            waiter.resolve(true);
        }
    }
    
    public wait(timeout: number): Promise<boolean>{
        return new Promise((resolve: (ret: boolean) => void) => {
            this.waiters.push(new Waiter(resolve, timeout));
        });
    }
}

class Waiter {
    private resolved = false;
    private timeout: NodeJS.Timeout;
    constructor(
        private resolveFunc: (ret: boolean) => void,
        timeout: number
    ){
        this.timeout = setTimeout(() => this.resolve(false), timeout);
    }
    
    resolve(ret: boolean){
        if(!this.resolved){
            clearTimeout(this.timeout);
            this.resolveFunc(ret);
            this.resolved = true;
        }
    }
}
