'use strict';

angular.module('Application').controller('SettingsController', ['$scope', '$location', '$rootScope', 'Client', 'AppStore', function ($scope, $location, $rootScope, Client, AppStore) {
    Client.onReady(function () { if (!Client.getUserInfo().admin) $location.path('/'); });

    $scope.client = Client;
    $scope.user = Client.getUserInfo();
    $scope.config = Client.getConfig();
    $scope.dnsConfig = {};
    $scope.appstoreConfig = {};

    $scope.mailConfig = null;

    $scope.lastBackup = null;
    $scope.backups = [];

    $scope.currency = null;

    $scope.availableRegions = [];
    $scope.currentRegionSlug = null;

    $scope.availablePlans = [];
    $scope.currentPlan = null;

    $scope.planChange = {
        busy: false,
        error: {},
        password: '',
        requestedPlan: null
    };

    $scope.createBackup = {
        busy: false,
        percent: 100
    };

    $scope.avatarChange = {
        busy: false,
        error: {},
        avatar: null,
        availableAvatars: [{
            file: null,
            data: null,
            url: '/img/avatars/avatar_0.png',
        }, {
            file: null,
            data: null,
            url: '/img/avatars/rubber-duck.png'
        }, {
            file: null,
            data: null,
            url: '/img/avatars/carrot.png'
        }, {
            file: null,
            data: null,
            url: '/img/avatars/cup.png'
        }, {
            file: null,
            data: null,
            url: '/img/avatars/football.png'
        }, {
            file: null,
            data: null,
            url: '/img/avatars/owl.png'
        }, {
            file: null,
            data: null,
            url: '/img/avatars/space-rocket.png'
        }, {
            file: null,
            data: null,
            url: '/img/avatars/armchair.png'
        }, {
            file: null,
            data: null,
            url: '/img/avatars/cap.png'
        }, {
            file: null,
            data: null,
            url: '/img/avatars/pan.png'
        }, {
            file: null,
            data: null,
            url: '/img/avatars/meat.png'
        }, {
            file: null,
            data: null,
            url: '/img/avatars/umbrella.png'
        }, {
            file: null,
            data: null,
            url: '/img/avatars/jar.png'
        }]
    };

    $scope.setPreviewAvatar = function (avatar) {
        $scope.avatarChange.avatar = avatar;
    };

    $scope.showCustomAvatarSelector = function () {
        $('#avatarFileInput').click();
    };

    function avatarChangeReset() {
        $scope.avatarChange.error.avatar = null;
        $scope.avatarChange.avatar = null;
        $scope.avatarChange.busy = false;
    }

    function fetchBackups() {
        Client.getBackups(function (error, backups) {
            if (error) return console.error(error);

            $scope.backups = backups;

            if ($scope.backups.length > 0) {
                $scope.lastBackup = backups[0];
            } else {
                $scope.lastBackup = null;
            }
        });
    }

    function getMailConfig() {
        Client.getMailConfig(function (error, mailConfig) {
            if (error) return console.error(error);

            $scope.mailConfig = mailConfig;
        });
    }

    $scope.toggleEmail = function () {
        Client.setMailConfig({ enabled: !$scope.mailConfig.enabled }, function (error) {
            if (error) return console.error(error);

            $scope.mailConfig.enabled = !$scope.mailConfig.enabled;
        });
    };

    function getPlans() {
        AppStore.getSizes(function (error, result) {
            if (error) return console.error(error);

            // only show plans bigger than the current size
            var found = false;
            result = result.filter(function (size) {
                if (size.slug === $scope.config.plan.slug) {
                    found = true;
                    return true;
                } else {
                    return found;
                }
            });
            angular.copy(result, $scope.availablePlans);

            // prepend the 'custom' plan'
            if ($scope.availablePlans.length === 0 || $scope.availablePlans[0].name !== $scope.config.plan.name) {
                $scope.availablePlans.unshift($scope.config.plan);
            }

            $scope.planChange.requestedPlan = $scope.availablePlans[0]; // need the reference to preselect

            AppStore.getRegions(function (error, result) {
                if (error) return console.error(error);

                angular.copy(result, $scope.availableRegions);

                $scope.currentRegionSlug = $scope.config.region;
            });
        });
    }

    $scope.showChangePlan = function () {
        $('#planChangeModal').modal('show');
    };

    function planChangeReset() {
        $scope.planChange.error.password = null;
        $scope.planChange.password = '';

        $scope.planChangeForm.$setPristine();
        $scope.planChangeForm.$setUntouched();
    }

    $scope.doChangePlan = function () {
        $scope.planChange.busy = true;

        var options = {
            size: $scope.planChange.requestedPlan.slug,
            name: $scope.planChange.requestedPlan.name,
            price: $scope.planChange.requestedPlan.price,
            region: $scope.currentRegionSlug
        };

        Client.migrate(options, $scope.planChange.password, function (error) {
            $scope.planChange.busy = false;

            if (error) {
                if (error.statusCode === 403) {
                    $scope.planChange.error.password = true;
                    $scope.planChange.password = '';
                    $scope.planChangeForm.password.$setPristine();
                    $('#inputPlanChangePassword').focus();
                } else {
                    console.error('Unable to change plan.', error);
                }
            } else {
                planChangeReset();

                $('#planChangeModal').modal('hide');

                window.location.href = '/update.html';
            }

            $scope.planChange.busy = false;
        });
    };

    function getBlobFromImg(img, callback) {
        var size = 256;

        var canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;

        var imageDimensionRatio = img.width / img.height;
        var canvasDimensionRatio = canvas.width / canvas.height;
        var renderableHeight, renderableWidth, xStart, yStart;

        if (imageDimensionRatio > canvasDimensionRatio) {
            renderableHeight = canvas.height;
            renderableWidth = img.width * (renderableHeight / img.height);
            xStart = (canvas.width - renderableWidth) / 2;
            yStart = 0;
        } else if (imageDimensionRatio < canvasDimensionRatio) {
            renderableWidth = canvas.width;
            renderableHeight = img.height * (renderableWidth / img.width);
            xStart = 0;
            yStart = (canvas.height - renderableHeight) / 2;
        } else {
            renderableHeight = canvas.height;
            renderableWidth = canvas.width;
            xStart = 0;
            yStart = 0;
        }

        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, xStart, yStart, renderableWidth, renderableHeight);

        canvas.toBlob(callback);
    }

    $scope.doChangeAvatar = function () {
        $scope.avatarChange.error.avatar = null;
        $scope.avatarChange.busy = true;

        var img = document.getElementById('previewAvatar');
        $scope.avatarChange.avatar.file = getBlobFromImg(img, function (blob) {
            Client.changeCloudronAvatar(blob, function (error) {
                if (error) {
                    console.error('Unable to change cloudron avatar.', error);
                } else {
                    Client.resetAvatar();
                }

                $('#avatarChangeModal').modal('hide');
                avatarChangeReset();
            });
        });
    };

    $scope.doCreateBackup = function () {
        $('#createBackupModal').modal('hide');
        $scope.createBackup.busy = true;
        $scope.createBackup.percent = 100;

        Client.backup(function (error) {
            if (error) {
                console.error(error);
                $scope.createBackup.busy = false;
            }

            function checkIfDone() {
                Client.progress(function (error, data) {
                    if (error) return window.setTimeout(checkIfDone, 250);

                    // check if we are done
                    if (!data.backup || data.backup.percent >= 100) {
                        if (data.backup && data.backup.message) console.error('Backup message: ' + data.backup.message); // backup error message
                        fetchBackups();
                        $scope.createBackup.busy = false;
                        return;
                    }

                    $scope.createBackup.percent = data.backup.percent;
                    window.setTimeout(checkIfDone, 250);
                });
            }

            checkIfDone();
        });
    };

    $scope.showCreateBackup = function () {
        $('#createBackupModal').modal('show');
    };

    $scope.showChangeAvatar = function () {
        avatarChangeReset();
        $('#avatarChangeModal').modal('show');
    };

    $('#avatarFileInput').get(0).onchange = function (event) {
        var fr = new FileReader();
        fr.onload = function () {
            $scope.$apply(function () {
                var tmp = {
                    file: event.target.files[0],
                    data: fr.result,
                    url: null
                };

                $scope.avatarChange.availableAvatars.push(tmp);
                $scope.setPreviewAvatar(tmp);
            });
        };
        fr.readAsDataURL(event.target.files[0]);
    };

    $scope.cloudronNameChange = {
        busy: false,
        error: {},
        name: '',

        reset: function () {
            $scope.cloudronNameChange.busy = false;
            $scope.cloudronNameChange.error.name = null;
            $scope.cloudronNameChange.name = '';

            $scope.cloudronNameChangeForm.$setUntouched();
            $scope.cloudronNameChangeForm.$setPristine();
        },

        show: function () {
            $scope.cloudronNameChange.reset();
            $scope.cloudronNameChange.name = $scope.config.cloudronName;
            $('#cloudronNameChangeModal').modal('show');
        },

        submit: function () {
            $scope.cloudronNameChange.error.name = null;
            $scope.cloudronNameChange.busy = true;

            Client.changeCloudronName($scope.cloudronNameChange.name, function (error) {
                $scope.cloudronNameChange.busy = false;

                if (error) {
                    if (error.statusCode === 400) {
                        $scope.cloudronNameChange.error.name = 'Invalid name';
                        $scope.cloudronNameChange.name = '';
                        $('#inputCloudronName').focus();
                        $scope.cloudronNameChangeForm.password.$setPristine();
                    } else {
                        console.error('Unable to change name.', error);
                        return;
                    }
                }

                $scope.cloudronNameChange.reset();
                $('#cloudronNameChangeModal').modal('hide');

                Client.refreshConfig();
            });
        }
    };

    Client.onReady(function () {
        fetchBackups();
        getMailConfig();

        if ($scope.config.provider === 'caas') {
            getPlans();

            $scope.currentPlan = $scope.config.plan;
            $scope.currency = $scope.config.currency === 'eur' ? '€' : '$';
        } else {
            Client.getAppstoreConfig(function (error, result) {
                if (error) return console.error(error);

                if (result.token) {
                    $scope.appstoreConfig = result;

                    AppStore.getProfile(result.token, function (error, result) {
                        if (error) return console.error(error);

                        $scope.appstoreConfig.profile = result;
                    });
                }
            });
        }
    });

    // setup all the dialog focus handling
    ['planChangeModal', 'appstoreLoginModal', 'cloudronNameChangeModal'].forEach(function (id) {
        $('#' + id).on('shown.bs.modal', function () {
            $(this).find("[autofocus]:first").focus();
        });
    });
}]);
